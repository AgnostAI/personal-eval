# personal-eval

Which model works best for *you*? Scores your models from your own coding-agent sessions.

```sh
npx personal-eval
```

![Example output (illustrative data)](./example.png)

Reads local sessions from Claude Code, Codex, Gemini CLI, opencode and fx. Nothing leaves your machine.

## Options

```
--models a,b    pick models (default: your two most used)
--since 30d     recent sessions only
--project x     sessions in matching folders only
--strict        tie unless the gap is statistically significant
--judge         label follow-ups with Claude (sends short snippets)
--list          show models found
--json          raw numbers
```

Every row is lower-is-better. If your models ran in different agents, harness differences are part of the result.

Inspired by [@rauchg](https://x.com/rauchg/status/2124880074168242369). Built by [Agnost AI](https://agnost.ai).
