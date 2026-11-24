/** Where the repo's work/ folder and the app are. (The fake agents the tests drive are node programs: see _fakes.ts.) */
export const WORK = new URL('../', import.meta.url);
export const APP = new URL('../app/', WORK);
