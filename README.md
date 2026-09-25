# 金属文物脱盐换液控制台

本地工作台使用的纯前端应用：修复师建立槽位、器物初始归属、电导率目标上限与所需连续轮数；
逐轮提交覆盖**槽内全部仍在浸泡器物**的整数电导率读数；只有各器物**自上次换液以来共同连续**
每一步严格下降、连续达到规定轮数且末值不高于上限时，才允许换液或完成出槽。

- 单件器物的短暂下降不会被判作整槽合格（整槽连续轮数取各浸泡器物的最小值）。
- 每轮采样必须**恰含一次**每件仍在浸泡器物的读数，且采样时间严格递增。
- 换液清空该槽轮次，重新计数；完成出槽的器物不再接受读数。
- 所有操作均为**不可改写事件**，页面状态完全由事件日志从首项记录重放得到。
- 操作以**所见修订号**乐观提交；同一方案在多个标签页打开时，陈旧操作被拒绝写入，
  页面自动显示其他标签页写入的最新状态。刷新或重新打开后，过程与资格完全还原（localStorage）。

## 本地开发

```bash
npm install
npm run dev       # 开发服务器
npm test          # 单元测试（Vitest）
npm run build     # 类型检查 + 生产构建到 dist/
npm run smoke     # 业务模块冒烟（Node 直接执行 TS）
npm run verify    # 测试 + 类型检查 + 构建 + 冒烟（与 verify 容器一致）
```

## Docker

静态站点（nginx）提供健康检查 `GET /health.html`；宿主机端口可用 `WEB_PORT` 配置（默认 8080）：

```bash
WEB_PORT=8080 docker compose up -d --build web
curl http://localhost:8080/health.html   # -> ok
```

`verify` 是一次性服务：完成单元测试、类型检查、生产构建、业务模块冒烟后自行退出，
以退出码报告结果（0 成功，非 0 失败）：

```bash
docker compose run --build --rm verify
echo "verify exit code: $?"
```

## 目录结构

```
src/domain/   领域核心（无 DOM 依赖）
  types.ts        类型、命令、事件与错误
  replay.ts       从首项事件重放状态
  qualification.ts 连续严格下降后缀 / 末值上限 / 整槽资格判定
  commands.ts     命令校验（含修订号乐观并发）
src/state/    localStorage 事件存储与跨标签页同步
src/ui/       控制台界面（逐轮趋势、下一步资格、修订号、事件过程）
test/         Vitest 单元测试
scripts/      Node 业务模块冒烟脚本
```
