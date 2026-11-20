import {
  importLibrary,
  setOptions,
} from "@googlemaps/js-api-loader";

let configuredKey: string | null = null;

function configureGoogleMaps(apiKey: string) {
  const normalizedKey = apiKey.trim();

  if (!normalizedKey) {
    throw new Error(
      "NEXT_PUBLIC_FLASH_GOOGLE_MAPS_API_KEY is not configured",
    );
  }

  if (
    configuredKey &&
    configuredKey !== normalizedKey
  ) {
    throw new Error(
      "Google Maps was already configured with another browser key",
    );
  }

  if (!configuredKey) {
    setOptions({
      key: normalizedKey,
      v: "weekly",
    });

    configuredKey = normalizedKey;
  }
}

export async function loadTrackingMapLibraries(
  apiKey: string,
) {
  configureGoogleMaps(apiKey);

  const [maps, geometry] =
    await Promise.all([
      importLibrary("maps"),
      importLibrary("geometry"),
    ]);

  return {
    maps:
      maps as google.maps.MapsLibrary,

    geometry:
      geometry as google.maps.GeometryLibrary,
  };
}
