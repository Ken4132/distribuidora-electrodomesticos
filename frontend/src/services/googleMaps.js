import { setOptions, importLibrary } from '@googlemaps/js-api-loader';

const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

if (!apiKey) {
    throw new Error('Falta VITE_GOOGLE_MAPS_API_KEY en el archivo .env');
}

setOptions({
    key: apiKey,
    v: 'weekly',
});

let mapsPromise = null;
let placesPromise = null;
let markerPromise = null;

export function loadMaps() {
    if (!mapsPromise) {
        mapsPromise = importLibrary('maps');
    }

    return mapsPromise;
}

export function loadPlaces() {
    if (!placesPromise) {
        placesPromise = importLibrary('places');
    }

    return placesPromise;
}

export function loadMarker() {
    if (!markerPromise) {
        markerPromise = importLibrary('marker');
    }

    return markerPromise;
}