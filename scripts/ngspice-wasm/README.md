# ngspice в WebAssembly

Для браузерной демо-версии: тот же ngspice, что и в программе для ПК, собранный emscripten.
Сборка — GitHub Actions «ngspice WebAssembly» (`build.sh`), результат — `vendor/ngspice-wasm/`.

- ngspice — модифицированная лицензия BSD (`vendor/ngspice-wasm/COPYING-ngspice`), исходники — зеркало
  https://github.com/danchitnis/ngspice-sf-mirror (официальный репозиторий — sourceforge.net/p/ngspice).
- Сценарий сборки и `hicum2_patch.sh` основаны на EEcircuit-engine, MIT License, Copyright (c) 2024 EElab.dev.
