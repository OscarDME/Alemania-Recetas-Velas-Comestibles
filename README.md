# Rezepte für essbare Kerzen — Landing Alemania

Landing de venta construida sobre la **estructura-ley de 14 bloques** (plantilla "Meu AuMigu"): su
convención de clases, su paleta olive/cream/terra y sus tipografías Fraunces + Inter.

Mercado único (**DE**) y un endpoint de servidor que captura la IP del visitante para la
**Conversions API de Meta**.

Clonada de la landing de USA (`edible-candle-recipes`). Los arreglos estructurales se portan entre
ambos proyectos: la jerarquía de rutas es la misma (`de/` aquí, `us/` allí).

## Mercado

| Mercado | Ruta | Divisa | Checkout |
|---|---|---|---|
| **DE** | `/de` | EUR, `27 €` | *(pendiente)* |

El visitante siempre ve la URL `/` — el edge hace **rewrite**, no redirect.

> **Nota sobre el orden.** Los `rewrites` de `vercel.json` se evalúan **después** del sistema de
> archivos. Por eso no hay `index.html` en la raíz: si lo hubiera, `/` casaría con el archivo y la
> regla de rewrite no llegaría a ejecutarse nunca.

### Si algún día se añade Austria o Suiza
Una regla por país en `vercel.json` → `rewrites`. **Nunca varias condiciones `has` en la misma
regla**: Vercel las evalúa en **AND**, así que una regla con dos países sería "país == AT Y
país == CH" y no casaría jamás. Con un solo país el AND es indistinguible del OR y el error pasa
desapercibido hasta que añades el segundo.

## Captura de IP y Conversions API

Un navegador **no conoce su propia IP pública** — ninguna API de JS la expone. Solo la ve quien
recibe la conexión. Por eso existe `api/track.mjs`, la única ruta dinámica del proyecto; todo lo
demás es HTML estático.

**Flujo.** El `<head>` genera `window.__pvEventId` de forma síncrona. Ese mismo id viaja por dos
caminos: el `fbq('track','PageView', {}, { eventID })` del navegador y el `event_id` que
`api/track.mjs` manda a Meta. Meta los une por `event_id` (ventana de 48 h) y cuenta **un** evento.

El envío por servidor **no espera a `fbevents.js`**: usa el id del `<head>` y dispara por su cuenta,
así que el evento llega aunque un bloqueador impida la librería de Meta.

**Qué se hashea y qué no.** `client_ip_address`, `client_user_agent`, `fbp` y `fbc` van **en claro**
— Meta lo exige así. `country`, `st`, `ct` y `zp`, derivados por Vercel de la IP, van en **SHA-256**
normalizado.

**La IP se usa y se descarta.** No hay base de datos, no se escribe en logs (los `console.error`
registran el código de estado de Meta, nunca el payload) y no vuelve al navegador: el endpoint
responde siempre `204` sin cuerpo.

### Dos allowlists que fallan en silencio

Son el fallo más caro de diagnosticar del proyecto, porque el endpoint **siempre** responde 204:

- **`ALLOWED_HOSTS`** (`api/track.mjs`) debe contener el dominio de producción. Si no coincide,
  `isSameOrigin()` da `false` y **todos** los eventos de servidor se descartan sin traza.
- **`ALLOWED_CURRENCIES`** debe contener `EUR`. Si no, el `InitiateCheckout` llega a Meta **sin
  `value` ni `currency`**, y las campañas no pueden optimizar por valor de conversión.

### Endurecimiento
- Allowlist de eventos: **solo `PageView` e `InitiateCheckout`**. `Purchase` está deliberadamente
  fuera porque lo envía OrioPay desde su lado; así no se duplica.
- Comprobación de `Origin` contra el dominio de producción.
- Tope de 2 KB en el cuerpo.
- **Siempre `204`**, pase lo que pase: si devolviera errores distintos sería un oráculo para
  averiguar si el token o el Pixel son válidos.

### Variables de entorno (Vercel → Settings → Environment Variables)

| Variable | Notas |
|---|---|
| `META_PIXEL_ID` | Pixel propio de Alemania. Si falta, la función cae al literal de `DEFAULT_PIXEL_ID`, así que ese literal y el del HTML no pueden divergir. |
| `META_CAPI_TOKEN` | Events Manager → Conversions API → generar token. Es **por Pixel**. **Secreto: solo servidor.** |
| `META_TEST_EVENT_CODE` | Opcional. Con valor, los eventos aparecen en Test Events. **Vacío en producción** o no cuentan en campañas. |

Para validar: con el test code puesto, en **Events Manager → Test Events** cada evento debe aparecer
como *Browser + Server*, deduplicado y con `client_ip_address` relleno.

## Atribución hacia el checkout

Al entrar se capturan de la query y se guardan en `localStorage` (prefijo `hotmart_`, sin caducidad,
misma convención que las otras landings):

```
src · fbclid · gclid · utm_source · utm_medium · utm_campaign · utm_content · utm_term
```

Al construir el enlace de compra se vuelven a leer —**la query manda sobre lo guardado**— y se
añaden a la URL de OrioPay. El `href` se fija al cargar (para que copiar el enlace también lo lleve)
y se recalcula en el clic. El `href` original vive en `data-checkout-base`, así que reaplicar es
idempotente y varios clics no acumulan parámetros.

Sin esto, el `Purchase` que OrioPay envía a Meta va sin identificador de clic y las campañas no
pueden atribuir la venta al anuncio.

## Particularidades del mercado alemán

Cosas que **no** se resuelven traduciendo y que hay que revisar al tocar copy:

- **Formato de precio.** El € va **detrás** del número, con espacio fino: `27 €`, no `$27`. Miles con
  punto y decimales con coma (`1.200,50 €`). Ya aplicado en el precio principal (`.mof-now .cur`) y
  en el calculador (`toLocaleString('de-DE')`).
- **Longitud del texto.** El alemán ocupa entre un 10 % y un 30 % más que el inglés. Hay
  `white-space:nowrap` en la barra marquee, en los badges del carrusel, en el precio y en las
  tarjetas del calculador: son los primeros sitios donde reventará la maqueta.
- **Anchos en `ch`** (`max-width:20ch` en el H1, `16ch`, `28ch`, `46ch`…) calibrados para inglés.
- **`text-transform:uppercase` con `letter-spacing` amplio** en 37 reglas: un compuesto alemán en
  versalitas desborda con facilidad.
- **Unidades.** °F → °C. El original tiene "eighty-degree weather" (≈ 27 °C).
- **`normalize()` en `api/track.mjs`** borra los diacríticos al hashear: "München" → `mnchen`. Es la
  normalización que Meta espera, pero conviene confirmarlo en Test Events con tráfico real.
- **Cumplimiento legal.** Ver más abajo.

## Pendiente legal (DE/UE)

La landing se clonó de un mercado sin estos requisitos. **Antes de mandar tráfico pagado**:

- **Consentimiento de cookies.** El Meta Pixel se dispara en el `<head>` sin ningún banner. Bajo
  TTDSG/DSGVO eso no es viable en Alemania.
- **Impressum** (§5 DDG). Obligatorio y sancionable; ahora no existe.
- **Datenschutzerklärung** (DSGVO) y **AGB**.
- **PAngV**: el precio debe indicar si incluye IVA ("inkl. MwSt.").
- **Widerrufsrecht**: los 14 días deben redactarse como derecho legal, no como cortesía comercial.
- Las afirmaciones de seguridad alimentaria del FAQ ("food-grade ingredients only") entran en el
  terreno de la LFGB.

## Estructura

```
├── de/index.html        ← la página
├── api/track.mjs        ← única ruta dinámica (IP + CAPI)
├── vercel.json          ← rewrite + headers
└── blocks/              ← 17 bloques, pegables en Elementor
```

Los archivos de `blocks/` son autocontenidos (cada uno con su `@import` de fuentes, sus variables
CSS y guardas `{% raw %}` alrededor de los `<script>`), listos para pegar en un widget HTML de
Elementor o en una sección de Shopify. Ningún bloque depende de otro. La excepción es
`99-capi-bridge.html`, que es solo `<script>` y por eso no lleva ni `@import` ni variables.

**La página es la fuente de verdad.** Los bloques se generan partiéndola por los marcadores
`<!-- ============ NN — … ============ -->`. Si editas la página, regenera los bloques.

> **Clonar a otro mercado no son dos líneas.** El README original afirmaba que bastaba con
> `window.__market` y el `href` del botón. El clon real de US a UK cambió **188 líneas**: divisa,
> precios de anclaje, locale de formateo, nombres de personas, avatares, comercios locales,
> festividades y todo el copy. Cuenta con eso.

## Desarrollo

```bash
python3 -m http.server 4173
```

Sirve `de/` como estático, pero **no** aplica el rewrite ni ejecuta `api/track.mjs`. Para probar el
endpoint hace falta `vercel dev` o el despliegue.

## Despliegue

Estático puro, sin build. Vercel redespliega en cada push a `main`.
Dominio de producción: `rezepte-fuer-essbare-kerzen.crearis.online`.

**El orden importa**: Vercel no permite vincular un dominio a un proyecto que no tenga ya un
despliegue de producción exitoso. Primero push, luego build en verde, y solo entonces el dominio.

Y antes del primer commit, `git config user.email` debe ser el correo real de la cuenta de GitHub:
con un correo sin credenciales, Vercel rechaza en silencio los despliegues de producción
(`COMMIT_AUTHOR_REQUIRED`).
