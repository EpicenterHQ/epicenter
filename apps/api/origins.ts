export const PRODUCTION_API_URL = 'https://api.epicenter.so';
export const LOCAL_API_ORIGIN = 'http://localhost:8787';

/** Origins used for both OAuth callbacks and the API's trusted-origin list. */
export const BROWSER_APP_ORIGINS = {
	todos: ['https://todos.epicenter.so', 'http://localhost:5186'],
	whispering: ['https://whispering.epicenter.so', 'http://localhost:1420'],
	capture: ['https://capture.epicenter.so', 'http://localhost:5179'],
	vocab: ['https://vocab.epicenter.so', 'http://localhost:8888'],
	zhongwen: ['https://zhongwen.bradenwong.com', 'http://localhost:5207'],
} as const;
