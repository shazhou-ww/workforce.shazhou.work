# 私有仓库统计生产候选

## 已发布

- Release 标签：`Release-261113-4`。
- 标签提交：`59b781f5947af408d9d3021b5f40c5e3f7abc713`，实现代码提交为
  `581e381bd7414aa9718506f05f7ac14a225611cf`。
- [生产部署 Action](https://github.com/shazhou-ww/workforce.shazhou.work/actions/runs/43356881143)
  已成功，包含完整 workspace 检查与 Worker/静态资源部署。
- Worker 版本：`491ee12d-d62a-4f15-a49f-7d1a7f2f7261`。
- 使用既有受权连接在打标签前应用
  `0006_private_repositories.sql`，迁移成功；迁移后确认独立表为空。未扩大 Actions 部署凭据权限，未执行本地 Worker 生产部署。

## 已验证的线上行为

- 健康接口返回 `status: ok`，GitHub 登录 bootstrap 与 CSRF 正常。
- 登录页面及配置路由返回 HTTP 200，新前端 bundle 包含私有配置入口。
- 原有公共活动接口返回 HTTP 200，匿名平台状态仍为 `signed_out`。
- 私有配置 GET、PUT、DELETE 与采集 POST 均拒绝匿名请求，返回 HTTP
  401；验证请求未创建授权或采集任务。
- 本地完整 `pnpm check`
  通过，487 项 Vitest 测试通过、1 项跳过；生产 Action 再次通过 workspace 检查。

## 尚待真实账号线上验收

当前没有获准用于在线验收的真实私有仓库令牌，未冒充已完成私有采集、跨账号验证或真实撤权。

验收入口为「个人配置 → 私有仓库」。使用当前 GitHub 主账号创建 fine-grained
PAT，选择一个资源所有者及指定私有仓库，设置有效期，Contents/Metadata 均为只读；企业审批仍由组织处理。连接后单独刷新私有统计，核对默认分支和主账号主要作者的提交结果。

继续验证另一账号及匿名访问无法读取私有内容，公开主页不包含私有统计；在 GitHub 撤权后确认旧结果隐藏，再断开并确认授权及快照删除。尚未完成的 D-S01、D-S03、D-AC01、D-AC02 与 D-AC03 保持未勾选，不提交部署验收。

## 停用与数据处置

用户可通过「断开私有授权并删除已有私有结果」删除当前配置与快照，使旧任务失效；还需自行在 GitHub 撤销不再使用的 PAT。已有下载副本不能召回，数据库历史备份不在即时删除承诺内。

如需全局停用，通过新的 Release 标签和相同 Action 发布不含私有入口的 Worker；保留增量表，不自动删除用户数据或改变公共快照。该全局停用方案尚未在线演练。
