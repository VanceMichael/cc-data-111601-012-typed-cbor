# 来源约定

## 产品交换范围

支持 RFC 8949 的 major type 0..7、uint64/nint64、byte/text、数组、map、tag、bool/null/undefined、简单值及 float16/32/64；不要求解读业务 tag 的语义，保留 tag 号与内容。CBOR sequence 是连续顶层数据项，不带长度前缀。字符串 UTF-8 严格校验；不定长 byte/text 只能拼同类定长 chunk，break 只结束当前不定长容器；map 有序条目允许重复键。输出协议自行设计但不能把 BigInt 或非有限浮点交给 JSON.stringify 后丢失。来源原件及每个顶层值跨度可追溯，深度/大小限制应显式失败。截断顶层尾值可以等待续收，结构损坏后没有同步点则停止该来源，不扫描猜测下一值。

## 当前来源路由

- `/primary`：application/octet-stream
- `/sequence`：application/octet-stream
- `/truncated`：application/octet-stream
- `/nested`：application/octet-stream

`/catalog` 提供入口及业务选择。资源字节支持 GET/HEAD、单一 bytes 范围、ETag 和 If-Match，响应不会跨来源重定向。`/_phase` 为联调控制路径，不是产品数据来源，不应由产品自行切换阶段。

## 依据和范围说明

- https://www.rfc-editor.org/rfc/rfc8949

以上是格式或业务词汇的公开依据；本项目明确限定的交换子集以本文及实际资源为准，未要求完整标准实现。元数据和未支持声明应保留可定位的来源，不把未知转换成已确认的空结果。HTTP 来源状态、原件结构和产品接收完整性是不同层次；现有通用收件接口成功只表示该单件已保存。

## 接收与查询表示（本实现）

### 无损值模型

顶层 CBOR sequence 按完整数据项切分，每个完整项登记一条记录。记录保留：

- `value`：类型化节点。整数为十进制字符串；byte 为 base64 与字节长度；map 为按来源顺序的 `entries` 数组，重复键保留为多条 entry；tag 保留 `tag` 号与内容；浮点保留原始宽度 `width` 和位型 `bits`，非有限值用 `special`，负零用 `negativeZero` 标记。
- `object`：整个来源响应的 SHA-256 摘要；`span.start`/`span.end` 指向该对象中的字节区间，`GET /records/{id}/bytes` 返回该区间。
- 节点上的 `start`/`end` 同样记录字节跨度，供定位；它们不是键身份的一部分。

不同 CBOR 类型的键不会折叠：整数 `1`、文本 `"1"`、byte `0x01`、tag、simple、bool 等各有独立规范键。整数按数值比较（`0x01` 与 `0x18 0x01` 命中同一键），浮点按数值加 NaN/负零区分，与编码宽度无关。复合键与 map 键保留来源顺序与重复条目。

### 序列接收

`POST /sequences` 接受 `{"path":"/sequence"}`，可选 `allowPending: true`。

响应块边界与值边界无关；读取按块增量解码。尾部结构不完整时：

- 默认返回 `409`，`{"error":"cbor_incomplete","pending":{"offset":...,"length":...}}`，不登记不完整项；
- `allowPending: true` 时登记完整前缀，返回 `202`（无完整记录）或 `201`，并附 `pending`。

结构损坏（保留 additional、非法 UTF-8、不定长 chunk 混类、break 位置错误、超出深度/条目/字节限制）会显式失败并停止该来源，不扫描后续字节寻找可解析起点。同一来源、同一对象摘要重领返回原记录 id。

`GET /records` 的返回仍为原数组；带查询参数时改为 `{"records":[...],"entries":[...]}`，不改变原接口形状：

- `?keyType=uint&key=1`：类型化键匹配；`keyType` 可为 `uint`、`nint`、`bytes`（base64）、`text`、`bool`、`null`、`undefined`、`simple`、`float`、`tag`（仅 tag 号）。
- `?keyType=uint`：任意该类型键的条目。
- `?key=<JSON>`：完整类型化键，如 `{"type":"tag","tag":"2","value":{"type":"bytes","base64":"AQ=="}}`；array/map 键也走此形式。
- `?tag=2`、`?valueType=bytes`：按值侧 tag 或值类型过滤，可与键过滤组合。

重复键查询返回全部匹配 entry；`path` 含所属 map 中的位置索引，可区分重复键、map 键与 tag 内容。单件 `/intakes` 的原有记录与返回形状保持不变。
