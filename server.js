// Минимальный сервер для Railway: отдаёт index.html, styles.css, app.js.
// Обработка документов по-прежнему выполняется в браузере.
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

// Раздача статики из корня репозитория
app.use(express.static(__dirname));

// Здесь в будущем появится прокси к Claude API:
// app.post("/api/anthropic", ...)  — ключ будет браться из process.env

app.listen(PORT, () => console.log(`Alta-TEST запущен на порту ${PORT}`));
