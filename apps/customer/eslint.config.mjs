import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// R3 area boundaries (docs/PLATAFORMA.md). Each product area lives in a route group:
//   app/(tienda)      public store and order tracking
//   app/(backoffice)  Ops and Admin; may host the Delivery panel
//   app/(delivery)    FlashCommerce Delivery (courier, monitor, drivers); must stand alone
//   app/(platform)    FlashCommerce Cloud platform console (R4); isolated from every business area
// Shared code lives in lib/ and app/_shared/ and must not import any area.
const area = (name) => [`**/(${name})/**`, `@/app/(${name})/**`];
const boundary = (files, forbidden, why) => ({
  files,
  rules: {
    "no-restricted-imports": ["error", { patterns: [{ group: forbidden.flatMap(area), message: why }] }],
  },
});

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  boundary(["app/(tienda)/**"], ["backoffice", "delivery", "platform"], "La tienda no importa el backoffice ni Delivery; usa lib/ o app/_shared/."),
  boundary(["app/(delivery)/**"], ["tienda", "backoffice", "platform"], "Delivery debe funcionar solo; mueve lo común a lib/ o app/_shared/."),
  boundary(["app/(backoffice)/**"], ["tienda", "platform"], "El backoffice no importa la tienda; mueve lo común a lib/ o app/_shared/."),
  boundary(["app/(platform)/**"], ["tienda", "backoffice", "delivery"], "La consola de plataforma no importa áreas de negocio."),
  boundary(["lib/**", "app/_shared/**"], ["tienda", "backoffice", "delivery", "platform"], "El código común no importa ningún área."),
  // Node CommonJS build scripts (run inside the Docker build) legitimately use require().
  { files: ["**/*.cjs"], rules: { "@typescript-eslint/no-require-imports": "off" } },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
