# @local/dsh-memory-starmap

把 `dsh-memento` 的记忆条目画成一张**只读星图**，作为 DSH 桌面/网页宿主里的一个客户端插件。

> 它不存记忆、不注入上下文、不注册模型工具。它只是把 `dsh-memento` 已经存在的那张表
> 换一种看法：**节点 = 一条记忆**（大小∝字符数，亮度∝召回次数，颜色=track），
> **连线 = 共享 tag / 词元重叠 / 同一会话**。

## 为什么值得看

| 看什么 | 回答什么问题 |
|---|---|
| 左下预算条 | 哪一层快到上限了（agent·workspace 4000 字符最容易撞墙） |
| 虚线环（孤立星） | 哪条记忆谁都不挨着——要么是独立事实，要么该合并 |
| 星团 | 同一主题散成了几条？能不能压成一条，把预算让出来 |
| 星体大小 | 一条记忆吃掉了多少预算（最大的那条通常是"教科书式长条目"） |
| 侧栏审计轨迹 | 这条记忆什么时候被 add/replace 过，谁批的 |

## 界面

- 左下角悬浮按钮 `✦ 星图`，可拖动（位置存 `localStorage: dsh.starmap.fab.position.v1`），双击回到默认位。
- 点开是全屏浮层：星图 + 搜索框 + 预算条 + 图例；`Esc` 或 `✕` 关闭。
- 浮层里是 iframe，关掉即销毁（canvas 的 rAF 循环跟着停，不留在后台耗电）。
- 页面里点星 → 右侧抽屉：全文 / tags / 字符数 / 召回次数 / 版本 / 时间 / 来源 / 审计。
- 顶栏 `重新读取` 强制重新拉一次数据（每次打开浮层也会重新拉）。

## 两条只读路由

| 路由 | 返回 |
|---|---|
| `GET /api/memory-starmap/graph` | `{ok, source, dbPath, generatedAt, entries[], budgets[], audit[]}` |
| `GET /api/memory-starmap/page` | 星图页面本体（HTML，运行时再 fetch 上一条） |

两条都只接受 GET，其它方法 405。数据面拿不到时返回 503 + 可读原因，页面顶部会显示错误横幅。

## 关键设计：不污染召回计数

`dsh-memento` 的 `query()` 会在末尾执行
`UPDATE entries SET recall_count = recall_count + 1`——用它取数，一开面板就把
"亮度"这个指标改掉了，图会越看越亮。

本插件走的是无副作用的读面：

- `service.store.listEntries()` —— 全量条目，不动计数
- `service.budgets()` —— 每层已用/上限
- `service.store.auditList(limit)` —— 审计尾

只有**完全没装 dsh-memento** 时才回落到 `node:sqlite` 直读（`{ readOnly: true }`），
此时预算按插件配置里的 `budgetLimits` 换算。图上会标注当前是 `service` 还是 `sqlite`。

## 配置

基线在 `cordis.patch.yml`（改动需重启宿主）：

```yaml
- insert:
    - id: memory-starmap
      name: '@local/dsh-memory-starmap'
      config:
        dbPath: ''          # 仅当没有 memory 服务时用；正常留空
        entryLimit: 2000    # 页面最多画多少节点
        auditLimit: 400     # 侧栏审计条数上限
        budgetLimits: { user: 2000, agent: 4000 }
```

## 开发与验证

```bash
NODE="C:/Users/hyqdz/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe"
"$NODE" tools/selftest.mjs                       # 宿主半侧 42 项（假 ctx/webServer/res）
"$NODE" tools/selftest.mjs --db D:/gzq/Memory/dsh-memento.db   # 再加真实库直读
"$NODE" tools/clienttest.mjs                     # 浏览器半侧 19 项（最小 DOM 桩）
```

装了之后还想验证活着：`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:<GUI端口>/api/memory-starmap/graph`
（GUI 端口每次启动都变，别硬编码）。

### 改完代码为什么要手动同步

profile 里这份包是 pnpm 从 `file:D:/gzq/dsh-memory-starmap` 装出来的**副本**
（`node_modules/@local/dsh-memory-starmap`，不是符号链接）。改了源文件后，`dsh plugin add`
不会刷新它（pnpm 认为依赖没变化，实测把版本号从 0.1.0 提到 0.1.1 也一样）。所以：

```powershell
$T="C:\Users\hyqdz\.dsh\profiles\desktop\node_modules\@local\dsh-memory-starmap"
Copy-Item D:\gzq\dsh-memory-starmap\index.mjs,D:\gzq\dsh-memory-starmap\package.json,D:\gzq\dsh-memory-starmap\cordis.patch.yml $T -Force
Copy-Item D:\gzq\dsh-memory-starmap\client\client.js $T\client -Force
Copy-Item D:\gzq\dsh-memory-starmap\ui\starmap.html $T\ui -Force
```

- 改 `client/client.js` 或 `ui/starmap.html`：同步后**刷新宿主页面**即可（客户端是 classic script，每次页面加载重新拉）。
- 改 `index.mjs`（宿主半侧）：需要重启 DSH 才生效。

## 星团折叠（同 tag 条目太多时）

- 规则：某个 tag 上的条目 ≥ `minCluster`（默认 **3**）就先叠成一颗「星团」，显示成 `tag ×N`
  （虚线环 + 成员数）。一条条目只进一个团：按「条数降序 + tag 字典序」贪心分配，
  所以「插件 ×46」不会把「沙盒 ×42」的成员全吃掉。
- 星团颜色 = 成员颜色的**平均**（它的归属层由成员决定，不能拿 tag 色冒充层级）。
- 点星团：散开成成员（星团节点留在中间当枢纽，辐条拉住成员）；再点一次收起。
- 展开状态点圈内空白也收起；圈内那条 `tag ×N · 点空白收起` 是提示不是标签。
- 星团**不算孤立条目**（它代表一大票条目，标成孤立会误导）。
- 合成数据演示（`合成 240 条 · 看极限`）默认**不折叠**，因为那一页要展示的就是「全铺开」的极限；
  想看成团效果就加 URL 参数：`/api/memory-starmap/page?minCluster=3` 再点「合成」。
- 调试参数：`?minCluster=N` 改折叠门槛；`&debug=1` 会把相机与首几个节点的坐标打到 console
  （排查「图飞到画布外」时用）。
