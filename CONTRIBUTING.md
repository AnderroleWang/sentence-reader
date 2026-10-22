# 参与改进句读

欢迎反馈实际阅读中遇到的问题、提出改进建议，或提交修复。项目目前处于实验阶段，优先关注句子对应、定位稳定性、长译文阅读和不同论文版式的兼容。

## 反馈问题

请在 [Issues](https://github.com/AnderroleWang/sentence-reader/issues) 中说明：

- 使用的版本、系统和浏览器。
- 如何导入文档、复现步骤、期望与实际表现。
- 截图或可以公开的最小示例，尽量指出出问题的页码和句子。

请隐藏 API 密钥、私人接口地址、个人批注和未公开论文。模型名及协议通常足够排查兼容性，无须提交凭据或完整服务日志。没有可公开 PDF 时，也可先用自拟文字描述版式问题。

## 本地开发

Python 3.9+，不需要 pip 或 npm 依赖。Edge / Chrome 近期版本即可。

```bash
git clone https://github.com/AnderroleWang/sentence-reader.git
cd sentence-reader
python -X utf8 server.py
```

macOS / Linux 可使用 `python3`。修改 `.mjs`、CSS、HTML 后刷新浏览器；修改 `server.py` 后重启本机服务。请使用单独的浏览器配置或测试端口，避免操作自己的正式阅读档案。

## 提交修改

围绕一个具体问题提交，说明触发场景、修改后的行为和验证方法。涉及对应关系时，请同时检查两种语言方向、跨页句组和档案导入导出；涉及布局时检查宽屏与窄屏。不要凭中文标点数量强制拆分已保存的译文组。

后端测试在本机运行，不需要真实 API：

```bash
python -m unittest discover -s tests -v
```

发行包使用 `scripts/build_release.py`，请保留白名单打包和隐私扫描，不提交真实论文、浏览器数据、模型密钥或运行时缓存。新增第三方代码或资源时，附来源、版本和许可证；不要复制未授权的代码。

本项目原创代码采用 MIT License；提交贡献表示你有权提供该内容，并同意以同一许可证分发。第三方组件仍采用各自许可证。
