/** Подключает браузерную реализацию window.elab до запуска интерфейса. */
import { webApi } from './webApi';

(window as unknown as { elab: unknown }).elab = webApi();
