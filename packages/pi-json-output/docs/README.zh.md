# pi-json-output

> English · [中文文档](./README.zh.md)

**一个 Pi 扩展，提供 `json_write` 工具——通过 DeepSeek API 生成符合 schema 验证的 JSON 输出，支持 `response_format: { type: "json_object" }`。**

## 安装

```bash
pi install npm:pi-json-output
# 或从本地安装：
pi install /path/to/pi-json-output
```

## 使用

LLM 在需要结构化 JSON 输出时自动调用 `json_write`：

```text
json_write({
  path: "output/data.json",
  schema: '{"type":"object","properties":{"name":{"type":"string"},"score":{"type":"number"}},"required":["name","score"]}',
  instruction: "Generate a test result from the conversation"
})
```

输出：经过验证的 JSON 写入指定文件。

## 工作原理

1. 工具从 LLM 接收 path、schema 和 instruction
2. 使用 schema 构建系统提示
3. 调用 DeepSeek Chat Completions API，设置 `response_format: { type: "json_object" }`
4. 验证输出：是否是有效 JSON？是否符合 schema？
5. 写入文件
6. 向 LLM 返回文件路径和摘要

## 依赖

- 需要 `DEEPSEEK_API_KEY` 环境变量，或通过 `/login deepseek` 登录
