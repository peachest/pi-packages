动机: 已经有一些评审工具可以评审/简化代码,例如 simplify skill, open-code-review 评审项目代码, ponytail 简化 agent 编写的代码.
但是有时候 agent 会编写过时的代码,这些代码是正确的,而且通常不会被简化或者评审发现问题. 我希望提供一个 modernize 的工具或者 skill,允许 agent 使用最新的语言特性,但是保持代码的兼容性.,
或者评审发现已经使用的过时的语言特性并且尝试修复.

限制:对 go 项目, 可以使用 go 1.26 提供的 go fix . 但是 typescript/javascript 没有对应的工具.
