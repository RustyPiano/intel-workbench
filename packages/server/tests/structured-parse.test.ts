import { describe, expect, it } from "vitest";

import { parseJsonOutput } from "../src/model/structured.js";

describe("parseJsonOutput 的保守修复回退（全链路彩排回归）", () => {
  it("严格合法 JSON 原样解析", () => {
    expect(parseJsonOutput('{"claims":[{"a":1}]}')).toEqual({ claims: [{ a: 1 }] });
  });

  it("数组元素间漏逗号可修复（温度 0 下模型稳定复现的malformation）", () => {
    const broken = '{"claims":[\n  {"entity":"蓝海星号","value":"22:30"}\n  {"entity":"蓝海星号","value":"23:30"}\n]}';
    expect(parseJsonOutput(broken)).toEqual({
      claims: [
        { entity: "蓝海星号", value: "22:30" },
        { entity: "蓝海星号", value: "23:30" },
      ],
    });
  });

  it("尾部截断的数组截取到最后完整元素（部分结果优于整批失败）", () => {
    const truncated = '{"claims":[{"entity":"甲","value":"1"},{"entity":"乙","value":"2"},{"entity":"丙","val';
    expect(parseJsonOutput(truncated)).toEqual({
      claims: [
        { entity: "甲", value: "1" },
        { entity: "乙", value: "2" },
      ],
    });
  });

  it("覆盖率敏感任务可拒绝尾部截断的部分 JSON", () => {
    const truncated = '{"claims":[{"entity":"甲","value":"1"},{"entity":"乙","val';
    expect(() => parseJsonOutput(truncated, { allowPartial: false })).toThrow();
  });

  it("字符串内的花括号与引号不被误修", () => {
    const tricky = '{"claims":[{"text":"引文含 } 与 { 以及 \\" 转义"}]}';
    expect(parseJsonOutput(tricky)).toEqual({ claims: [{ text: '引文含 } 与 { 以及 " 转义' }] });
  });

  it("修不回的乱输出仍抛错", () => {
    expect(() => parseJsonOutput("完全不是 JSON")).toThrow();
    expect(() => parseJsonOutput('{"a": [}')).toThrow();
  });
});
