# ① 浏览器脚本

两个独立的 Tampermonkey 脚本，装法都是：打开 Tampermonkey 面板 → 添加新脚本 →
把这个 `.user.js` 拖进浏览器窗口（或整段粘贴覆盖）→ 保存。

## quiz/ · 刷题助手

| 文件 | 说明 |
|---|---|
| `csgmooc-helper.user.js` | 脚本本体（v1.6.2，单文件，约 210 KB） |
| `使用说明.md` | 安装、做题、设置、报错排查 |

能力：单选 / 多选 / 判断 / 填空 / 连线 / 主观题；多家 AI 服务商（可检测模型）；
本地题库优先；延迟提交；无人值守；跳过规则；题库导入导出。

## materials/ · 资料助手

| 路径 | 说明 |
|---|---|
| `userscript/csgmooc-materials.user.js` | 油猴版（主推，v1.3.1） |
| `userscript/test_materials_userscript.mjs` | 离线单测（桩页面） |
| `userscript/panel-preview.png` | 面板长什么样 |
| `cli/` | Python CLI 版（可选）：`list / inspect / complete` |
| `README.md` | 原理与安全设计 |

## 注意：安卓端有脚本副本

`03-安卓APP/app/src/main/assets/yzj-quiz.user.js` 和 `yzj-mat.user.js` 是这两份脚本的副本
（打包进 APK 用）。**更新脚本后要同步复制过去**，否则安卓端跑的还是旧版。
