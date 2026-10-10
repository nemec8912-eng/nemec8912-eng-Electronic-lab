// Эксперимент для CI: берётся ли блокировка единственного экземпляра при разных именах папки профиля.
const { app } = require('electron');
const path = require('node:path');
const name = process.argv[process.argv.length - 1];
app.setPath('userData', path.join(app.getPath('appData'), name));
const ok = app.requestSingleInstanceLock();
console.log(`::warning title=singleton-probe::userData «${name}» → requestSingleInstanceLock = ${ok}`);
app.exit(0);
