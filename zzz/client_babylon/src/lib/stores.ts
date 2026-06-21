import { writable } from 'svelte/store';

// Load settings from localStorage or use defaults
const defaultSettings = {
  lookSensitivity: 0.00075, // Raw sensitivity multiplier
  invertY: true,
  fov: 90
};

const savedSettings = localStorage.getItem('gameSettings');
const initialSettings = savedSettings ? { ...defaultSettings, ...JSON.parse(savedSettings) } : defaultSettings;

export const gameSettings = writable(initialSettings);

// Subscribe to changes and save to localStorage
gameSettings.subscribe((value) => {
  localStorage.setItem('gameSettings', JSON.stringify(value));
});
