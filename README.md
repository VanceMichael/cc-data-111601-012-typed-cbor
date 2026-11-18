# typed-cbor

设备交付中异构映射键的无损结构化接收相关资料接收服务，面向授权来源的原件领取、解释和持久查询。

## 当前能力

- 兼容能力：简单 CBOR 字符串键映射的单值查看与原件保存（`src/reader.mjs`，入口 `POST /intakes`）。
- 类型化能力：RFC 8949 交换子集的无损 CBOR/CBOR sequence 接收（`src/cbor.mjs`，入口 `POST /sequence-intakes`）。数字键 1、文本键 "1"、标签键互不折叠；重复 map 键保留全部条目与原件顺序；二进制值、uint64/nint64、tag、不定长容器、简单值与 float16/32/64（含 NaN/Infinity/负零标记）均以 JSON 安全节点表示。
- 流式保真：按字节流增量解析，分块位置与值边界无关；每个顶层值记录在原件中的绝对字节跨度。截断的尾值可等待续收，最终不完整显式拒收；结构损坏毒化来源，不扫描后续字节猜测新记录。
- 可查询：类型化键精确查询、整数范围（有符号 BigInt 比较）、嵌套路径回溯；原件读取支持交换约定的单一闭合 bytes 范围。

`src/reader.mjs` 提供现有单件读取契约；`src/transport.mjs` 只访问配置来源的同源地址，拒绝隐式跳转，并提供流式领取；`src/store.mjs` 保存原件摘要和解释结果。`src/service.mjs` 是产品入口，`src/provider.mjs` 是独立 HTTP 联调来源，内容为无个人信息的本地样例。

## 环境与运行

Node.js 22.22 至 22.x，无 npm 依赖，无外部运行服务或下载步骤。Linux、Windows 均使用以下命令；干净目录可直接运行。

```sh
npm ci --offline --ignore-scripts
npm test
npm run build
npm run demo
```

`npm run demo` 自动在本机回环端口启动来源与产品、领取一件资料、读取已保存结果，然后关闭服务并清理临时目录。它展示当前产品能力，不模拟尚不存在的能力。演示没有固定等待、外网访问或人工操作，通常数秒结束。扩展产品后可按实际能力更新演示路径；不要以打印预先保存的结果替代运行。

直接 `npm start` 即可启动产品，默认自动在临时回环端口创建本地合成来源，产品默认监听 127.0.0.1:4102。退出产品时同步关闭自带来源。需要联调独立来源时先运行 `npm run source`，再设置 SOURCE_URL=http://127.0.0.1:4101 运行 `npm start`；显式来源不会由产品关闭。DATA_DIR 可设置资料目录，PORT 可覆盖产品监听端口。构建产物位于 dist，启动、测试与演示均不需要外部服务或下载。

## 已有接口

- GET /health：服务状态。
- POST /intakes，JSON 为 {"path":"/primary"}：按现有 reader 接收单件原件；内容解释失败不登记资料。
- POST /sequence-intakes，JSON 为 {"path":"/sequence"}：流式接收 CBOR sequence，分块边界任意；截断或结构损坏返回 422 且不登记。
- GET /records：持久接收目录；同 source URL、同摘要重领返回原 id。
- GET /objects/{digest}：读取已保存的原始字节；支持 `Range: bytes=start-end` 单一闭合范围（206 + Content-Range），非法或越界返回 416。
- GET /documents/{digest}：类型化无损表示，含每个顶层值节点与原件字节跨度；旧的兼容记录返回 409。
- GET /documents/{digest}/entries：类型化 map 条目查询，参数 `keyType`（uint/nint/text/bytes/bool/null/undefined/simple）、`key`、`tag`、整数范围 `keyMin`/`keyMax`；重复键返回全部命中并保持顺序，结果含顶层项序号、嵌套路径与键值节点。

GET 请求均为只读，不会把 GET 变为写操作。收件记录当前只包含单件 raw 对象，不代表关联资料已完整。

## 来源与资料

交换范围、字段和边界见 [来源约定](docs/upstream.md)，样例资源清单可访问来源的 /catalog。`fixtures/upstream.json` 描述 HTTP 资源和阶段变体，不包含产品实现。GET /_requests 可查实际领取请求；POST /_phase 接收 {"phase":1} 切换已定义的来源状态，切回 0 恢复。所有资料都限于公开约定或本地合成数据，不向真实业务系统写入。

## 测试与构建

`npm test` 覆盖现有读取器、畸形输入、真实 HTTP 领取、原件一致性、持久重开、同源边界和范围响应；领域读取行为在 test/domain.test.mjs，完整 CBOR 子集与序列增量解析在 test/cbor.test.mjs，类型化接收/查询/拒收端到端行为在 test/typed-inbox.test.mjs。`npm run build` 对运行模块逐个执行语法校验并复制到 dist。`docker build -t typed-cbor:local .` 可创建产品运行镜像；镜像默认运行实际演示，不含远程业务凭据。
