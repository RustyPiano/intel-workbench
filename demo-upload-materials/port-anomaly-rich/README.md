# 港口异常活动演示上传包

这个目录用于演示“新建专题 -> 上传材料 -> 加工/检索/研判/生成报告”。

## 目录说明

- `documents/`：整理后的 19 份案卷文本，按证据链分组，适合人工讲解。
- `text/`：同样 19 份原始记录风格文本的扁平版本，适合上传控件不支持文件夹时使用。
- `media/`：4 个多媒体附件，适合演示图片、音频、视频上传和加工；这批文件与下面的案卷文本没有事实关联，只用于验证多模态处理能力，不是案发现场影像。
- `DOCUMENT_INDEX.md`：每份文档的用途、关键矛盾和建议演示问题。

## 建议上传顺序

1. 新建专题，名称可用：`港口异常活动线索核验演示`。
2. 优先上传 `documents/` 下所有文件。
3. 如果页面不支持选择文件夹，改为上传 `text/` 下所有 `.txt` 文件。
4. `media/` 下 4 个文件建议作为单独一批“多模态加工能力测试素材”上传和讲解，不要和案卷文本混在一起讲——它们和案情没有事实关联，画面/音频内容不对应蓝海星号、LH-7712 或三号门的任何细节。
5. 视频约 74 MB，上传和加工会慢一些；演示时间紧时可以先跳过 MP4。

## 多媒体素材

以下 4 个文件只用于验证图片/视频/音频的上传、加工和许可留存能力，与前面 19 份案卷文本没有事实关联：

- `01-dvids-port-honolulu-container-inspection-public-domain.jpg`
  - 真实下载图片，拍摄于檀香山港，不是本案地点。
  - 来源：https://www.dvidshub.net/image/8969502/coast-guard-leads-multi-agency-security-operation-port-honolulu
  - 页面标注 Public Domain。
- `02-wikimedia-colombo-express-night-cc0.jpeg`
  - 真实下载图片，拍摄于汉堡阿尔滕韦尔德港区，不是本案地点。
  - 来源：https://commons.wikimedia.org/wiki/File:Colombo_Express_in_Altenwerder_at_night-799096.jpeg
  - 页面标注 CC0 1.0。
- `03-local-generated-vhf-radio-demo.wav`
  - 本地生成的通联语音，只用于 ASR 上传演示。
  - 不是公开来源原始音频，也不是本案 VTS 通话录音。
- `04-dvids-port-security-training-public-domain.mp4`
  - 真实下载视频，约 74 MB，拍摄于旧金山湾的训练演习，不是本案地点或事件。
  - 来源：https://www.dvidshub.net/video/1010679/us-coast-guard-port-security-unit-312-conducts-simulated-training-exercises-san-francisco-bay
  - 页面标注 Public Domain。

## 演示重点

- 靠泊时间冲突：值班简报说 22:30 已靠泊，AIS/VTS/泊位计划指向 23:30 左右。
- 三号门车辆冲突：人工登记 2 辆，OCR 和堆场复核显示 4 辆。
- LH-7712 流转冲突：仓储未到仓，但堆场、聊天、照片说明都显示夜间出现在东三泊位北侧。
- 封志/查验冲突：海关预约要求查验前不得拆封，现场照片显示封志缺失，巡检又记录封志完好。

## 可直接提问

- `这批材料里最关键的矛盾是什么？`
- `蓝海星号是否真的在 22:30 靠泊？`
- `三号门车辆登记有什么问题？`
- `LH-7712 是否存在违规拆封或转运迹象？`
- `还缺哪些材料才能闭环？`

## 注意

本上传包不包含 PDF。现在本机已安装 liteparse，新上传 PDF 才会被解析成页级文本；安装前已经上传并处于 pending 的旧 PDF 需要删除后重传。
