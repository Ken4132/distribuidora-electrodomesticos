import { useEffect, useRef, useState } from 'react';
import {
    loadMaps,
    loadPlaces,
    loadMarker,
} from '../services/googleMaps.js';

const DEFAULT_CENTER = {
    lat: 14.6349,
    lng: -90.5069,
};

function getAddressComponent(components, types) {
    const component = components?.find((item) =>
        types.some((type) => item.types?.includes(type))
    );

    return component?.longText || '';
}

export default function GoogleAddressPicker({
    latitude = null,
    longitude = null,
    onSelect,
}) {
    const autocompleteContainerRef = useRef(null);
    const mapContainerRef = useRef(null);

    const mapRef = useRef(null);
    const markerRef = useRef(null);
    const autocompleteRef = useRef(null);

    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    useEffect(() => {
        let cancelled = false;

        async function initialize() {
            try {
                setLoading(true);
                setError('');

                const [
                    { Map },
                    { PlaceAutocompleteElement },
                    { AdvancedMarkerElement },
                ] = await Promise.all([
                    loadMaps(),
                    loadPlaces(),
                    loadMarker(),
                ]);

                if (cancelled) return;

                const hasCoordinates =
                    Number.isFinite(Number(latitude)) &&
                    Number.isFinite(Number(longitude));

                const initialPosition = hasCoordinates
                    ? {
                          lat: Number(latitude),
                          lng: Number(longitude),
                      }
                    : DEFAULT_CENTER;

                if (!mapRef.current && mapContainerRef.current) {
                    mapRef.current = new Map(mapContainerRef.current, {
                        center: initialPosition,
                        zoom: hasCoordinates ? 16 : 7,
                        mapTypeControl: false,
                        streetViewControl: false,
                        fullscreenControl: true,
                        mapId: 'DEMO_MAP_ID',
                    });
                }

                if (hasCoordinates && mapRef.current) {
                    mapRef.current.setCenter(initialPosition);
                    mapRef.current.setZoom(16);

                    if (!markerRef.current) {
                        markerRef.current = new AdvancedMarkerElement({
                            map: mapRef.current,
                            position: initialPosition,
                        });
                    } else {
                        markerRef.current.position = initialPosition;
                    }
                }

                if (
                    !autocompleteRef.current &&
                    autocompleteContainerRef.current
                ) {
                    const autocomplete =
                        new PlaceAutocompleteElement();

                    autocomplete.placeholder =
                        'Busca una dirección o lugar…';

                    autocomplete.includedRegionCodes = ['gt'];
                    autocomplete.requestedLanguage = 'es';

                    autocomplete.addEventListener(
                        'gmp-select',
                        async (event) => {
                            try {
                                setError('');

                                const place =
                                    event.placePrediction.toPlace();

                                await place.fetchFields({
                                    fields: [
                                        'displayName',
                                        'formattedAddress',
                                        'location',
                                        'addressComponents',
                                    ],
                                });

                                if (!place.location) {
                                    setError(
                                        'Google no devolvió coordenadas para esta ubicación.'
                                    );
                                    return;
                                }

                                const selected = {
                                    address:
                                        place.formattedAddress ||
                                        place.displayName ||
                                        '',
                                    latitude:
                                        place.location.lat(),
                                    longitude:
                                        place.location.lng(),
                                    municipality:
                                        getAddressComponent(
                                            place.addressComponents,
                                            [
                                                'locality',
                                                'administrative_area_level_2',
                                            ]
                                        ),
                                    department:
                                        getAddressComponent(
                                            place.addressComponents,
                                            [
                                                'administrative_area_level_1',
                                            ]
                                        ),
                                };

                                if (mapRef.current) {
                                    mapRef.current.setCenter(
                                        place.location
                                    );
                                    mapRef.current.setZoom(17);
                                }

                                if (markerRef.current) {
                                    markerRef.current.position =
                                        place.location;
                                } else if (mapRef.current) {
                                    markerRef.current =
                                        new AdvancedMarkerElement({
                                            map: mapRef.current,
                                            position:
                                                place.location,
                                        });
                                }

                                onSelect(selected);
                            } catch (selectionError) {
                                console.error(selectionError);

                                setError(
                                    'No fue posible obtener los datos de la ubicación.'
                                );
                            }
                        }
                    );

                    autocompleteContainerRef.current.appendChild(
                        autocomplete
                    );

                    autocompleteRef.current = autocomplete;
                }
            } catch (loadError) {
                console.error(
                    'Error cargando Google Maps:',
                    loadError
                );

                if (!cancelled) {
                    setError(
                        'No fue posible cargar Google Maps.'
                    );
                }
            } finally {
                if (!cancelled) {
                    setLoading(false);
                }
            }
        }

        initialize();

        return () => {
            cancelled = true;

            if (markerRef.current) {
                markerRef.current.map = null;
                markerRef.current = null;
            }

            if (
                autocompleteRef.current &&
                autocompleteContainerRef.current?.contains(
                    autocompleteRef.current
                )
            ) {
                autocompleteContainerRef.current.removeChild(
                    autocompleteRef.current
                );
            }

            autocompleteRef.current = null;
            mapRef.current = null;
        };
    }, []);

    useEffect(() => {
        if (!mapRef.current) return;

        const hasCoordinates =
            Number.isFinite(Number(latitude)) &&
            Number.isFinite(Number(longitude));

        if (!hasCoordinates) return;

        const position = {
            lat: Number(latitude),
            lng: Number(longitude),
        };

        mapRef.current.setCenter(position);
        mapRef.current.setZoom(16);

        if (markerRef.current) {
            markerRef.current.position = position;
        }
    }, [latitude, longitude]);

    return (
        <div className="span-3">
            <div className="field">
                <label className="field__label">
                    Ubicación en Google Maps
                </label>

                <div
                    ref={autocompleteContainerRef}
                    style={{
                        width: '100%',
                        marginBottom: '10px',
                    }}
                />

                {loading && (
                    <div className="field__hint">
                        Cargando Google Maps…
                    </div>
                )}

                {error && (
                    <div className="field__error">
                        {error}
                    </div>
                )}

                <div
                    ref={mapContainerRef}
                    style={{
                        width: '100%',
                        height: '280px',
                        borderRadius: '10px',
                        overflow: 'hidden',
                        border:
                            '1px solid var(--border, #d1d5db)',
                        background: '#f3f4f6',
                    }}
                />

                <div
                    className="field__hint"
                    style={{ marginTop: '6px' }}
                >
                    Busca y selecciona una ubicación de las
                    sugerencias para guardar automáticamente sus
                    coordenadas.
                </div>
            </div>
        </div>
    );
}