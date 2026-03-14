---
name: open
description: Открыть HTML-отчёт report.html в браузере
allowed-tools: Bash
---

# Открыть отчёт

Открой report.html в браузере через локальный HTTP-сервер (для корректной кодировки UTF-8).

## Команда

```bash
.tools/node-v24.14.0-win-x64/node.exe -e "require('http').createServer((q,r)=>{require('fs').readFile('report.html',(e,d)=>{r.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});r.end(d)})}).listen(8787,()=>console.log('http://localhost:8787'))"
```

Запусти в фоне и сообщи пользователю URL: http://localhost:8787
