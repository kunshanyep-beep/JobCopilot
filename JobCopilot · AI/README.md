# JobCopilot · AI 扩展

当前版本：**1.1.6**。此目录是 Chrome / Edge 实际加载的扩展目录。

项目介绍、本分支功能改进、技术实现与测试说明见 [项目首页](../README.md)，历史更新见 [版本记录](../docs/CHANGELOG.md)。

## 安装

1. 打开 `chrome://extensions` 或 `edge://extensions`，开启开发者模式。
2. 点击“加载解压缩的扩展”，选择本目录（包含 `manifest.json`）。
3. 登录 BOSS 直聘，点击扩展图标打开侧栏。
4. 配置 DeepSeek API Key、简历文字和搜索条件，收集并人工审核岗位后启动投递。

无需构建或安装 npm 依赖。更新代码后重新加载扩展、刷新相关 BOSS 页面并重开侧栏。

## 开发验证

在仓库根目录执行：

```bash
npm ci
npm test
```

本分支由 [kunshanyep-beep](https://github.com/kunshanyep-beep) 维护，基于 [上游 JobCopilot](https://github.com/huluobo2237-pixel/JobCopilot) 继续开发，保留 [MIT 许可及原版权声明](LICENSE)。
