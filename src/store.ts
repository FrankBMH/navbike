import AsyncStorage from '@react-native-async-storage/async-storage';
import { Weights } from './score';

const HIST_KEY = 'navbike.history.v1';
const FAV_KEY = 'navbike.favs.v1';
const W_KEY = 'navbike.weights.v1';
const MAX = 50;
const MAX_FAV = 8;

export type Place = { name: string; location: string };

export type Saved = {
  id: string;
  at: number;
  from: Place;
  to: Place;
  vias: Place[];
  scoreA: number;
  gradeA: string;
  kmA: number;
  minA: number;
  scoreB?: number;
  gradeB?: string;
};

export type Fav = {
  id: string;
  name: string;
  from: Place;
  to: Place;
  vias: Place[];
};

export async function loadHistory(): Promise<Saved[]> {
  try {
    const raw = await AsyncStorage.getItem(HIST_KEY);
    return raw ? (JSON.parse(raw) as Saved[]) : [];
  } catch {
    return [];
  }
}

export async function saveRecord(r: Saved): Promise<Saved[]> {
  const list = await loadHistory();
  const next = [r, ...list].slice(0, MAX);
  await AsyncStorage.setItem(HIST_KEY, JSON.stringify(next));
  return next;
}

export async function removeRecord(id: string): Promise<Saved[]> {
  const list = await loadHistory();
  const next = list.filter(x => x.id !== id);
  await AsyncStorage.setItem(HIST_KEY, JSON.stringify(next));
  return next;
}

export async function loadFavs(): Promise<Fav[]> {
  try {
    const raw = await AsyncStorage.getItem(FAV_KEY);
    return raw ? (JSON.parse(raw) as Fav[]) : [];
  } catch {
    return [];
  }
}

export async function saveFav(f: Fav): Promise<Fav[]> {
  const list = await loadFavs();
  const next = list.some(x => x.name === f.name)
    ? list.map(x => (x.name === f.name ? f : x))
    : [...list, f].slice(0, MAX_FAV);
  await AsyncStorage.setItem(FAV_KEY, JSON.stringify(next));
  return next;
}

export async function removeFav(id: string): Promise<Fav[]> {
  const list = await loadFavs();
  const next = list.filter(x => x.id !== id);
  await AsyncStorage.setItem(FAV_KEY, JSON.stringify(next));
  return next;
}

export async function loadWeights(): Promise<Weights | null> {
  try {
    const raw = await AsyncStorage.getItem(W_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (typeof j?.time !== 'number' || typeof j?.turn !== 'number' || typeof j?.road !== 'number') {
      return null;
    }
    return { time: j.time, turn: j.turn, road: j.road };
  } catch {
    return null;
  }
}

export async function saveWeights(w: Weights): Promise<void> {
  try {
    await AsyncStorage.setItem(W_KEY, JSON.stringify(w));
  } catch {}
}
