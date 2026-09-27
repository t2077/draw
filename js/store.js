// localStorage 多存档。数据结构：
// { current: 存档名, slots: { 存档名: { entities: [...], view: {...} } } }

const KEY = 'draw.slots.v1';
const DEFAULT_NAME = '默认';

function emptyData() {
  return { current: DEFAULT_NAME, slots: { [DEFAULT_NAME]: { entities: [], view: null } } };
}

export function loadData() {
  try {
    const data = JSON.parse(localStorage.getItem(KEY));
    if (data && data.slots && data.slots[data.current]) return data;
  } catch (err) {
    console.warn('存档读不出来，用空档', err);
  }
  return emptyData();
}

export function saveData(data) {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch (err) {
    console.warn('存档写不进去', err);
  }
}

export function createSlot(data, name) {
  data.slots[name] = { entities: [], view: null };
  data.current = name;
  return data;
}

export function removeSlot(data, name) {
  delete data.slots[name];
  if (!Object.keys(data.slots).length) return emptyData();
  if (data.current === name) data.current = Object.keys(data.slots)[0];
  return data;
}
