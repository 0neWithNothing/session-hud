# session-hud

Мод для Claude Code: живая панель в оранжевой рамке под строкой режима.

- модель и effort
- время сессии и хода, стоимость по ценам API, число ответов
- контекстное окно с прогресс-баром
- лимиты 5ч / 7д с временем до сброса и прогнозом по темпу расхода
- правки файлов (+/− строки), работающие агенты
- топ вызовов инструментов и скиллов
- тосты при 90% контекста или лимита
- `/hud` — переключить полный / компактный вид

## Установка

Нужны свежий Claude Code (`claude update`) и установленный git.

Внутри сессии Claude Code:

```
/plugin marketplace add 0neWithNothing/session-hud
/plugin install session-hud@session-hud
```

Или из обычного терминала:

```
claude plugin marketplace add 0neWithNothing/session-hud
claude plugin install session-hud@session-hud
```

Панель появится в новой сессии. Работает в терминале и в десктоп-приложении Claude (не в расширении VS Code).
