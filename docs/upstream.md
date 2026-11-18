# 来源约定

## 产品交换范围

支持 RFC 8949 的 major type 0..7、uint64/nint64、byte/text、数组、map、tag、bool/null/undefined、简单值及 float16/32/64；不要求解读业务 tag 的语义，保留 tag 号与内容。CBOR sequence 是连续顶层数据项，不带长度前缀。字符串 UTF-8 严格校验；不定长 byte/text 只能拼同类定长 chunk，break 只结束当前不定长容器；map 有序条目允许重复键。输出协议自行设计但不能把 BigInt 或非有限浮点交给 JSON.stringify 后丢失。来源原件及每个顶层值跨度可追溯，深度/大小限制应显式失败。截断顶层尾值可以等待续收，结构损坏后没有同步点则停止该来源，不扫描猜测下一值。

## 产品侧落地约定

- 类型化节点（`src/cbor.mjs`）：所有解释结果为带 `kind` 的 JSON 安全节点。uint/nint 与 tag 号用十进制字符串承载 64 位精度；bytes 用 base64；非有限浮点（NaN/Infinity/-Infinity）与负零带显式标记，不交给 `JSON.stringify` 的默认转换。
- map 表示为有序 `entries`（每项含类型化 `key`/`value`），整数键 1、文本键 "1"、标签键互不等同，重复键全部保留并保持原件顺序，不用最后一个值消解。
- CBOR sequence 增量解析按字节流推送，分块位置与值边界无关；每个顶层值记录在整条原件中的绝对字节跨度 `span`。缓冲不足只保留尾部待续；结构错误毒化该来源，后续字节不做同步点扫描。
- 显式限制：嵌套深度 128、节点总数 200000、缓冲 8MiB，超限以具名错误失败。
- 整数范围查询（`keyMin`/`keyMax`）按 BigInt 数值比较有符号整数；bytes 范围指 HTTP `Range: bytes=start-end` 单一闭合区间，非法或越界返回 416。

## 当前来源路由

- `/primary`：application/octet-stream
- `/sequence`：application/octet-stream
- `/truncated`：application/octet-stream
- `/nested`：application/octet-stream

`/catalog` 提供入口及业务选择。资源字节支持 GET/HEAD、单一 bytes 范围、ETag 和 If-Match，响应不会跨来源重定向。`/_phase` 为联调控制路径，不是产品数据来源，不应由产品自行切换阶段。

## 依据和范围说明

- https://www.rfc-editor.org/rfc/rfc8949

以上是格式或业务词汇的公开依据；本项目明确限定的交换子集以本文及实际资源为准，未要求完整标准实现。元数据和未支持声明应保留可定位的来源，不把未知转换成已确认的空结果。HTTP 来源状态、原件结构和产品接收完整性是不同层次；现有通用收件接口成功只表示该单件已保存。
