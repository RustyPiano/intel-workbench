import { afterEach, describe, expect, it, vi } from "vitest";

import { CloudAsrAdapter, mapTranscription, sniffAudioName, wavDurationSeconds } from "../src/model/cloud-asr.js";

/** 造一个 canonical PCM WAV 头（+空 data 体），byteRate/dataSize 可控以验时长解析。 */
function makeWav(byteRate: number, dataSize: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + dataSize, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // 单声道
  h.writeUInt32LE(16000, 24); // sampleRate
  h.writeUInt32LE(byteRate, 28); // byteRate
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(dataSize, 40);
  return Buffer.concat([h, Buffer.alloc(dataSize)]);
}

describe("ASR 纯函数（映射 / 时长 / 格式嗅探）", () => {
  it("mapTranscription：{text} → 整段单段（无说话人，timecode=[0,时长]）；空文本→无段", () => {
    expect(mapTranscription({ text: "  海军舰艇南海训练  " }, 5)).toEqual({
      duration: 5,
      segments: [{ start: 0, end: 5, text: "海军舰艇南海训练" }],
    });
    expect(mapTranscription({ text: "   " }, 5)).toEqual({ duration: 5, segments: [] });
    expect(mapTranscription({}, 3)).toEqual({ duration: 3, segments: [] });
  });

  it("wavDurationSeconds：解析 PCM WAV 头算时长；非 WAV → 0", () => {
    expect(wavDurationSeconds(makeWav(32000, 64000))).toBe(2); // 64000/32000
    expect(wavDurationSeconds(makeWav(32000, 16000))).toBe(0.5);
    expect(wavDurationSeconds(Buffer.from("not a wav at all"))).toBe(0);
    expect(wavDurationSeconds(Buffer.alloc(4))).toBe(0);
  });

  it("sniffAudioName：按魔数给扩展名", () => {
    expect(sniffAudioName(makeWav(32000, 0))).toBe("audio.wav");
    expect(sniffAudioName(Buffer.from("ID3\x03blah"))).toBe("audio.mp3");
    expect(sniffAudioName(Buffer.from("OggS....", "ascii"))).toBe("audio.ogg");
    expect(sniffAudioName(Buffer.concat([Buffer.alloc(4), Buffer.from("ftypM4A ", "ascii")]))).toBe("audio.m4a");
    expect(sniffAudioName(Buffer.from([0xff, 0xfb, 0x90, 0x00]))).toBe("audio.mp3"); // MPEG 帧同步
  });
});

describe("CloudAsrAdapter.transcribe（mock fetch）", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POST /audio/transcriptions：multipart(model+file)+Bearer，映射为整段结果", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ text: "南海方向发现可疑舰船活动" }),
    }));
    vi.stubGlobal("fetch", fetch);
    const adapter = new CloudAsrAdapter("https://api.siliconflow.cn/v1/", { model: "FunAudioLLM/SenseVoiceSmall", apiKey: "k" });
    const wav = makeWav(32000, 64000); // 2s
    const out = await adapter.transcribe(wav);
    expect(out.duration).toBe(2);
    expect(out.segments).toEqual([{ start: 0, end: 2, text: "南海方向发现可疑舰船活动" }]);
    expect(adapter.engine).toBe("asr:FunAudioLLM/SenseVoiceSmall");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("https://api.siliconflow.cn/v1/audio/transcriptions");
    const init = fetch.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
  });

  it("非 WAV 输入（无法解析时长）→ duration 0、整段 [0,0]（仅文本可检索/引用）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ text: "录音内容" }) })));
    const out = await new CloudAsrAdapter("https://x/v1", { model: "m" }).transcribe(Buffer.from("ID3 fake mp3"));
    expect(out).toEqual({ duration: 0, segments: [{ start: 0, end: 0, text: "录音内容" }] });
  });

  it("非 2xx 抛出", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    await expect(new CloudAsrAdapter("https://x/v1", { model: "m" }).transcribe(Buffer.from("x"))).rejects.toThrow(/500/);
  });

  it("构造期缺 model 报错", () => {
    expect(() => new CloudAsrAdapter("https://x/v1", { model: "" })).toThrow(/model/);
  });
});
