// LA weather sky — Three.js + raindrop-fx
import * as THREE from 'three';
import RaindropFX from 'raindrop-fx';

(async () => {
    const visibleCanvas = document.getElementById('sky');
    if (!visibleCanvas) return;

    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Mobile / low-power heuristic — phones, tablets, and touch-first devices
    const isMobile = matchMedia('(max-width: 768px)').matches
                  || matchMedia('(hover: none) and (pointer: coarse)').matches;
    const dprCap = isMobile ? 1.5 : 2;

    // Three.js renders to its own offscreen canvas, then we drawImage that
    // into a 2D proxy canvas. raindrop-fx samples the 2D proxy (much friendlier
    // than reading from another WebGL canvas).
    const skyCanvas = document.createElement('canvas');
    const proxyCanvas = document.createElement('canvas');
    const proxyCtx = proxyCanvas.getContext('2d');
    const palmVideo = document.querySelector('video.palms');

    let renderer;
    try {
        renderer = new THREE.WebGLRenderer({
            canvas: skyCanvas,
            antialias: true,
            alpha: false,
            powerPreference: 'high-performance',
            preserveDrawingBuffer: true, // raindrop-fx needs to read pixels back
        });
    } catch (e) {
        document.body.style.background = 'linear-gradient(180deg,#1e3a8a 0%,#fef3c7 100%)';
        return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap));
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    let aspect = window.innerWidth / window.innerHeight;
    const camera = new THREE.OrthographicCamera(-aspect, aspect, 1, -1, -10, 10);
    camera.position.z = 1;

    // ---------- SKY (gradient + clouds + sun glow + rays) ----------
    const skyMat = new THREE.ShaderMaterial({
        uniforms: {
            uTime:     { value: 0 },
            uTopColor: { value: new THREE.Color(0.05, 0.10, 0.25) },
            uBotColor: { value: new THREE.Color(0.10, 0.20, 0.40) },
            uCloud:    { value: 0.3 },
            uHaze:     { value: 0.0 },
            uRain:     { value: 0.0 },
            uSunAlt:   { value: 0.0 },
            uSunUv:    { value: new THREE.Vector2(0.5, 0.8) },
            uNight:    { value: 0.0 },
            uAspect:   { value: aspect },
        },
        vertexShader: /* glsl */`
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = vec4(position.xy, 0.999, 1.0);
            }
        `,
        fragmentShader: /* glsl */`
            precision highp float;
            varying vec2 vUv;
            uniform float uTime, uCloud, uRain, uHaze, uSunAlt, uNight, uAspect;
            uniform vec3 uTopColor, uBotColor;
            uniform vec2 uSunUv;

            float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
            float noise(vec2 p) {
                vec2 i = floor(p), f = fract(p);
                vec2 u = f*f*(3.0-2.0*f);
                return mix(mix(hash21(i),             hash21(i+vec2(1,0)), u.x),
                           mix(hash21(i+vec2(0,1)),   hash21(i+vec2(1,1)), u.x), u.y);
            }
            float fbm(vec2 p) {
                float v = 0.0, a = 0.5;
                mat2 r = mat2(0.8, 0.6, -0.6, 0.8);
                for (int i = 0; i < 6; i++) {
                    v += a * noise(p);
                    p = r * p * 2.05;
                    a *= 0.5;
                }
                return v;
            }

            void main() {
                vec2 uv = vUv;

                // Flat sky — single base color (no top→bottom ombre).
                // Subtle vertical variation only (5%) to avoid total flatness.
                vec3 base = mix(uBotColor, uTopColor, 0.5);
                vec3 col = base * (0.95 + 0.05 * uv.y);

                // sun glow halos
                if (uSunAlt > 0.02) {
                    vec2 d = (uv - uSunUv) * vec2(uAspect, 1.0);
                    float r = length(d);
                    float halo = exp(-r * 4.5) * 0.55;
                    float wide = exp(-r * 1.4) * 0.18;
                    col += vec3(1.0, 0.85, 0.62) * (halo + wide) * uSunAlt;
                }

                // sun god rays — angular streaks attenuated by distance + cloud cover
                if (uSunAlt > 0.02 && uCloud < 0.85) {
                    vec2 d = (uv - uSunUv) * vec2(uAspect, 1.0);
                    float ang = atan(d.y, d.x);
                    float dist = length(d);
                    float rays = sin(ang * 26.0 + uTime * 0.7) * 0.5 + 0.5;
                    rays *= sin(ang * 13.0 - uTime * 0.5) * 0.5 + 0.5;
                    rays *= sin(ang * 7.0  + uTime * 0.3) * 0.5 + 0.5;
                    rays *= exp(-dist * 1.6);
                    col += vec3(1.0, 0.94, 0.74) * rays * uSunAlt * (1.0 - uCloud * 0.85) * 0.45;
                }

                // --- clouds (two layers: low/mid detail + high flat overcast) ---
                vec3 dayCloud = vec3(0.97, 0.97, 1.00);
                vec3 nightCloud = vec3(0.06, 0.08, 0.16);
                vec3 cloudCol = mix(dayCloud, nightCloud, uNight * 0.85);
                cloudCol = mix(cloudCol, cloudCol * 0.5, uRain * 0.55);

                // Layer 1 — chunky fbm clouds (dominant shapes)
                vec2 cuv1 = uv * vec2(uAspect, 1.0) * 2.4;
                cuv1.x += uTime * 0.014;
                float cl1 = fbm(cuv1);
                // Slide threshold *much* more at high coverage so 100% cloud = near-total overcast
                float lo1 = 0.52 - uCloud * 0.52;  // 0.52 → 0.00
                float hi1 = 0.80 - uCloud * 0.18;  // 0.80 → 0.62
                cl1 = smoothstep(lo1, hi1, cl1);
                col = mix(col, cloudCol, cl1 * (0.35 + uCloud * 0.65));

                // Layer 2 — finer, slower drifting wisps on top
                vec2 cuv2 = uv * vec2(uAspect, 1.0) * 4.2 + vec2(17.0, 3.0);
                cuv2.x += uTime * 0.006;
                float cl2 = fbm(cuv2);
                float lo2 = 0.58 - uCloud * 0.40;
                cl2 = smoothstep(lo2, 0.82, cl2);
                col = mix(col, cloudCol, cl2 * uCloud * 0.45);

                // Overcast flattening — at very high cover, wash the whole sky toward cloudCol
                float overcast = smoothstep(0.75, 1.0, uCloud);
                col = mix(col, cloudCol * 0.92, overcast * 0.55);

                // --- atmospheric haze (low visibility) ---
                // Haze rises from the horizon and lightens the sky evenly.
                vec3 hazeCol = mix(cloudCol, vec3(0.85, 0.87, 0.92), 0.35);
                hazeCol = mix(hazeCol, hazeCol * 0.45, uNight * 0.8);
                float hazeBand = mix(0.55, 1.0, 1.0 - uv.y); // thicker near horizon
                col = mix(col, hazeCol, uHaze * hazeBand * 0.65);

                // vignette
                vec2 vc = uv - 0.5;
                col *= 1.0 - dot(vc, vc) * 0.45;

                // grain
                col += (hash21(uv * 999.0 + uTime) - 0.5) * 0.012;

                gl_FragColor = vec4(col, 1.0);
            }
        `,
        depthWrite: false,
        depthTest: false,
    });
    const skyMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), skyMat);
    skyMesh.frustumCulled = false;
    skyMesh.renderOrder = -10;
    scene.add(skyMesh);

    // ---------- STARS ----------
    const STAR_COUNT = isMobile ? 700 : 1400;
    const starGeom = new THREE.BufferGeometry();
    {
        const pos = new Float32Array(STAR_COUNT * 3);
        const size = new Float32Array(STAR_COUNT);
        const phase = new Float32Array(STAR_COUNT);
        const color = new Float32Array(STAR_COUNT * 3);
        for (let i = 0; i < STAR_COUNT; i++) {
            pos[i * 3]     = (Math.random() - 0.5) * 6;
            pos[i * 3 + 1] = Math.random() * 1.6 - 0.05;
            pos[i * 3 + 2] = -0.5;
            size[i] = 0.8 + Math.pow(Math.random(), 8) * 4.5;
            phase[i] = Math.random() * 6.28318;
            const t = Math.random();
            let r = 1, g = 1, b = 1;
            if (t > 0.85 && t < 0.95)      { r = 1.00; g = 0.92; b = 0.78; }
            else if (t >= 0.95)            { r = 0.78; g = 0.86; b = 1.00; }
            color[i * 3]     = r;
            color[i * 3 + 1] = g;
            color[i * 3 + 2] = b;
        }
        starGeom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        starGeom.setAttribute('aSize',    new THREE.BufferAttribute(size, 1));
        starGeom.setAttribute('aPhase',   new THREE.BufferAttribute(phase, 1));
        starGeom.setAttribute('aColor',   new THREE.BufferAttribute(color, 3));
    }
    const starMat = new THREE.ShaderMaterial({
        uniforms: {
            uTime:    { value: 0 },
            uOpacity: { value: 0 },
            uPx:      { value: 1 },
        },
        vertexShader: /* glsl */`
            attribute float aSize;
            attribute float aPhase;
            attribute vec3  aColor;
            varying vec3  vColor;
            varying float vPhase;
            uniform float uPx;
            void main() {
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                gl_PointSize = aSize * uPx;
                vColor = aColor;
                vPhase = aPhase;
            }
        `,
        fragmentShader: /* glsl */`
            varying vec3 vColor;
            varying float vPhase;
            uniform float uTime;
            uniform float uOpacity;
            void main() {
                vec2 c = gl_PointCoord - 0.5;
                float d = length(c);
                if (d > 0.5) discard;
                float core = smoothstep(0.5, 0.0, d);
                float halo = exp(-d * 9.0) * 0.25;
                float twinkle = 0.70 + 0.30 * sin(vPhase + uTime * 1.8);
                float a = (core + halo) * twinkle * uOpacity * 0.85;
                gl_FragColor = vec4(vColor * a, a);
            }
        `,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
    });
    const stars = new THREE.Points(starGeom, starMat);
    stars.frustumCulled = false;
    stars.renderOrder = 0;
    scene.add(stars);

    // ---------- SUN ----------
    const sunMat = new THREE.ShaderMaterial({
        uniforms: { uOpacity: { value: 0 }, uTime: { value: 0 } },
        vertexShader: /* glsl */`
            varying vec2 vUv;
            void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
        `,
        fragmentShader: /* glsl */`
            varying vec2 vUv;
            uniform float uOpacity;
            uniform float uTime;
            void main() {
                vec2 c = vUv - 0.5;
                float d = length(c) * 2.0;
                float core = smoothstep(0.30, 0.18, d);
                float corona = smoothstep(0.55, 0.25, d) * 0.35;
                float glow = exp(-d * 3.2) * 0.55;
                vec3 hot = vec3(1.0, 0.97, 0.92);
                vec3 warm = vec3(1.0, 0.85, 0.55);
                vec3 col = mix(warm, hot, core);
                float a = (core + corona + glow) * uOpacity;
                gl_FragColor = vec4(col * a, a);
            }
        `,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
    });
    const sun = new THREE.Mesh(new THREE.PlaneGeometry(0.65, 0.65), sunMat);
    sun.frustumCulled = false;
    sun.renderOrder = 1;
    scene.add(sun);

    // ---------- MOON ----------
    const moonMat = new THREE.ShaderMaterial({
        uniforms: { uPhase: { value: 0 }, uOpacity: { value: 0 } },
        vertexShader: /* glsl */`
            varying vec2 vUv;
            void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
        `,
        fragmentShader: /* glsl */`
            varying vec2 vUv;
            uniform float uPhase;
            uniform float uOpacity;

            float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
            float noise(vec2 p) {
                vec2 i = floor(p), f = fract(p);
                vec2 u = f*f*(3.0-2.0*f);
                return mix(mix(hash21(i),             hash21(i+vec2(1,0)), u.x),
                           mix(hash21(i+vec2(0,1)),   hash21(i+vec2(1,1)), u.x), u.y);
            }
            float fbm(vec2 p) {
                float v = 0.0, a = 0.5;
                for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.05; a *= 0.5; }
                return v;
            }

            void main() {
                vec2 c = vUv - 0.5;
                float d = length(c) * 2.0;

                // Halo (always additive — pure light)
                float halo = exp(-d * 3.5) * 0.30;
                vec3 col = vec3(0.95, 0.96, 1.10) * halo;

                if (d < 1.0) {
                    float z = sqrt(max(0.0, 1.0 - d * d));
                    vec3 n = vec3(c.x * 2.0, c.y * 2.0, z);
                    float a = uPhase * 6.2831853;
                    vec3 L = normalize(vec3(sin(a), 0.06, -cos(a)));
                    float lit = max(0.0, dot(n, L));
                    lit = smoothstep(0.0, 0.20, lit);
                    float crat = fbm(n.xy * 5.0) * 0.18 + noise(n.xy * 14.0) * 0.08;
                    float disk = smoothstep(1.0, 0.94, d);
                    vec3 moonCol = vec3(0.97, 0.95, 0.88) * (1.0 - crat);
                    // Additive: ONLY add light from the lit side. Unlit side stays invisible.
                    col += moonCol * lit * disk;
                }

                gl_FragColor = vec4(col * uOpacity, 1.0);
            }
        `,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
    });
    const moon = new THREE.Mesh(new THREE.PlaneGeometry(0.30, 0.30), moonMat);
    moon.frustumCulled = false;
    moon.renderOrder = 1;
    scene.add(moon);


    // ---------- Resize ----------
    let raindropFx = null;
    function resize() {
        const w = window.innerWidth, h = window.innerHeight;
        aspect = w / h;
        camera.left = -aspect;
        camera.right = aspect;
        camera.top = 1;
        camera.bottom = -1;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h, false);
        const dpr = renderer.getPixelRatio();
        skyMat.uniforms.uAspect.value = aspect;
        starMat.uniforms.uPx.value = dpr;
        proxyCanvas.width = w;
        proxyCanvas.height = h;
        if (raindropFx) {
            visibleCanvas.width = w;
            visibleCanvas.height = h;
            raindropFx.resize(w, h);
        }
    }
    window.addEventListener('resize', resize);
    resize();

    // ---------- Time-of-day palette ----------
    const PALETTE = [
        [0.00, [0.02, 0.03, 0.10], [0.04, 0.05, 0.13]],
        [0.18, [0.04, 0.05, 0.16], [0.20, 0.12, 0.28]],
        [0.25, [0.18, 0.22, 0.48], [0.95, 0.55, 0.42]],
        [0.32, [0.30, 0.55, 0.88], [1.00, 0.82, 0.62]],
        [0.50, [0.22, 0.50, 0.85], [0.62, 0.85, 1.00]],
        [0.72, [0.20, 0.45, 0.82], [0.95, 0.78, 0.58]],
        [0.78, [0.40, 0.28, 0.62], [1.00, 0.50, 0.32]],
        [0.83, [0.12, 0.10, 0.30], [0.55, 0.22, 0.42]],
        [0.92, [0.03, 0.04, 0.13], [0.10, 0.08, 0.20]],
        [1.00, [0.02, 0.03, 0.10], [0.04, 0.05, 0.13]],
    ];
    const lerp = (a, b, t) => a + (b - a) * t;
    function paletteAt(t) {
        for (let i = 0; i < PALETTE.length - 1; i++) {
            const [t0, top0, bot0] = PALETTE[i];
            const [t1, top1, bot1] = PALETTE[i + 1];
            if (t >= t0 && t <= t1) {
                const k = (t - t0) / (t1 - t0);
                const e = k * k * (3 - 2 * k);
                return {
                    top: [lerp(top0[0], top1[0], e), lerp(top0[1], top1[1], e), lerp(top0[2], top1[2], e)],
                    bot: [lerp(bot0[0], bot1[0], e), lerp(bot0[1], bot1[1], e), lerp(bot0[2], bot1[2], e)],
                };
            }
        }
        return { top: PALETTE[0][1], bot: PALETTE[0][2] };
    }

    function laTimeOfDay() {
        const fmt = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/Los_Angeles',
            hour12: false, hour: '2-digit', minute: '2-digit',
        });
        const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
        const h = parseInt(parts.hour, 10);
        const m = parseInt(parts.minute, 10);
        return ((h % 24) + m / 60) / 24;
    }

    function moonPhase() {
        const synodic = 29.530588853;
        const ref = Date.UTC(2000, 0, 6, 18, 14, 0);
        const days = (Date.now() - ref) / 86400000;
        return ((days % synodic) + synodic) % synodic / synodic;
    }

    // ---------- Weather code → label (Open-Meteo WMO codes) ----------
    function weatherLabelFor(code) {
        if (code == null) return '—';
        if (code === 0) return 'Clear';
        if (code === 1) return 'Mostly clear';
        if (code === 2) return 'Partly cloudy';
        if (code === 3) return 'Overcast';
        if (code === 45 || code === 48) return 'Fog';
        if (code >= 51 && code <= 57) return 'Drizzle';
        if (code >= 61 && code <= 67) return 'Rain';
        if (code >= 71 && code <= 77) return 'Snow';
        if (code >= 80 && code <= 82) return 'Rain showers';
        if (code >= 85 && code <= 86) return 'Snow showers';
        if (code >= 95) return 'Thunderstorm';
        return '—';
    }
    function compassFor(deg) {
        if (deg == null || isNaN(deg)) return '';
        const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
        return dirs[Math.round(((deg % 360) / 22.5)) % 16];
    }
    function moonLabelFor(p) {
        // p in 0..1 where 0 = new, 0.5 = full
        if (p < 0.03 || p > 0.97) return 'New Moon';
        if (p < 0.22) return 'Waxing Crescent';
        if (p < 0.28) return 'First Quarter';
        if (p < 0.47) return 'Waxing Gibbous';
        if (p < 0.53) return 'Full Moon';
        if (p < 0.72) return 'Waning Gibbous';
        if (p < 0.78) return 'Last Quarter';
        return 'Waning Crescent';
    }

    // ---------- Modes / weather state ----------
    let mode = 'auto';
    let realWeather = {
        cloud: 0.30, cloudLow: 0, cloudMid: 0, cloudHigh: 0,
        visibilityM: 24000, haze: 0,
        rain: 0.0,
        tempC: null,
        apparentC: null,
        humidity: null,
        windKph: null,
        windDir: null,
        weatherCode: null,
        isDay: null,
    };
    const PRESETS = {
        sun:   { cloud: 0.05, haze: 0.00, rain: 0.0, forceTime: 0.50 },
        cloud: { cloud: 0.92, haze: 0.25, rain: 0.0, forceTime: 0.50 },
        rain:  { cloud: 0.98, haze: 0.55, rain: 1.0 },
        night: { cloud: 0.20, haze: 0.00, rain: 0.0, forceTime: 0.02 },
    };
    const state  = { cloud: 0.30, rain: 0.0, haze: 0.0, displayTod: laTimeOfDay() };
    const target = { cloud: 0.30, rain: 0.0, haze: 0.0, tod: state.displayTod };

    window.__setSkyMode = (m) => {
        mode = m;
        if (m === 'auto') {
            target.cloud = realWeather.cloud;
            target.rain  = realWeather.rain;
            target.haze  = realWeather.haze;
        } else if (PRESETS[m]) {
            target.cloud = PRESETS[m].cloud;
            target.rain  = PRESETS[m].rain;
            target.haze  = PRESETS[m].haze ?? 0;
        }
    };

    window.__getLA = () => {
        const tod = laTimeOfDay();
        const mp = moonPhase();
        return {
            mode,
            location: 'Marina del Rey, CA',
            // Live weather from Open-Meteo
            cloud:       realWeather.cloud,
            cloudLow:    realWeather.cloudLow,
            cloudMid:    realWeather.cloudMid,
            cloudHigh:   realWeather.cloudHigh,
            visibilityM: realWeather.visibilityM,
            haze:        realWeather.haze,
            rain:        realWeather.rain,
            tempC:       realWeather.tempC,
            apparentC:   realWeather.apparentC,
            humidity:    realWeather.humidity,
            windKph:     realWeather.windKph,
            windDir:     realWeather.windDir,
            windCompass: compassFor(realWeather.windDir),
            weatherCode: realWeather.weatherCode,
            weatherLabel: weatherLabelFor(realWeather.weatherCode),
            isDay:       realWeather.isDay,
            // Astronomy (computed locally)
            timeOfDay:   tod,
            moonPhase:   mp,
            moonLabel:   moonLabelFor(mp),
        };
    };
    // Dispatch an event whenever realWeather is refreshed so UI can react
    function emitLAUpdate() {
        try { window.dispatchEvent(new CustomEvent('la:weather', { detail: window.__getLA() })); }
        catch (_) {}
    }

    const CACHE_KEY = 'sky.weather.v3';
    const CACHE_TTL = 10 * 60 * 1000;
    async function fetchWeather() {
        try {
            const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
            if (cached && Date.now() - cached.t < CACHE_TTL) return cached.data;
            // Marina del Rey, CA
            const url = 'https://api.open-meteo.com/v1/forecast'
                + '?latitude=33.9802&longitude=-118.4517'
                + '&current=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,'
                + 'visibility,precipitation,is_day,temperature_2m,apparent_temperature,'
                + 'relative_humidity_2m,wind_speed_10m,wind_direction_10m,weather_code'
                + '&wind_speed_unit=kmh&temperature_unit=celsius'
                + '&timezone=America/Los_Angeles';
            const r = await fetch(url);
            const j = await r.json();
            const c = j.current || {};
            const precip = c.precipitation ?? 0;
            // Treat trace precipitation (< 0.1 mm/hr) as no rain.
            // Map 0.1..3 mm/hr to 0..1 visible intensity.
            const rainAmt = precip < 0.1 ? 0 : Math.max(0, Math.min(1, (precip - 0.1) / 2.9));
            // Visibility → haze (0 = clear, 1 = pea-soup). Open-Meteo gives meters.
            // Smooth ramp from 20km (fully clear) down to 3km (fully hazy).
            const visM = c.visibility ?? 24000;
            const haze = 1 - Math.max(0, Math.min(1, (visM - 3000) / 17000));
            const data = {
                cloud:       Math.max(0, Math.min(1, (c.cloud_cover ?? 30) / 100)),
                cloudLow:    Math.max(0, Math.min(1, (c.cloud_cover_low  ?? 0) / 100)),
                cloudMid:    Math.max(0, Math.min(1, (c.cloud_cover_mid  ?? 0) / 100)),
                cloudHigh:   Math.max(0, Math.min(1, (c.cloud_cover_high ?? 0) / 100)),
                visibilityM: visM,
                haze:        haze,
                rain:        rainAmt,
                tempC:       c.temperature_2m ?? null,
                apparentC:   c.apparent_temperature ?? null,
                humidity:    c.relative_humidity_2m ?? null,
                windKph:     c.wind_speed_10m ?? null,
                windDir:     c.wind_direction_10m ?? null,
                weatherCode: c.weather_code ?? null,
                isDay:       c.is_day ?? null,
            };
            localStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), data }));
            return data;
        } catch (e) {
            return {
                cloud: 0.30, cloudLow: 0, cloudMid: 0, cloudHigh: 0,
                visibilityM: 24000, haze: 0, rain: 0.0,
                tempC: null, apparentC: null, humidity: null,
                windKph: null, windDir: null, weatherCode: null, isDay: null,
            };
        }
    }
    fetchWeather().then(w => {
        realWeather = w;
        if (mode === 'auto') {
            target.cloud = w.cloud;
            target.rain  = w.rain;
            target.haze  = w.haze;
            state.cloud  = w.cloud;
            state.rain   = w.rain;
            state.haze   = w.haze;
        }
        emitLAUpdate();
    });
    setInterval(async () => {
        try { localStorage.removeItem(CACHE_KEY); } catch (_) {}
        const w = await fetchWeather();
        realWeather = w;
        if (mode === 'auto') {
            target.cloud = w.cloud;
            target.rain  = w.rain;
            target.haze  = w.haze;
        }
        emitLAUpdate();
    }, CACHE_TTL);

    // ---------- Animation loop ----------
    let lastT = performance.now();
    let acc = 0;
    let running = !document.hidden;

    function lerpAngle(a, b, t) {
        let d = b - a;
        if (d > 0.5) d -= 1;
        if (d < -0.5) d += 1;
        return (a + d * t + 1) % 1;
    }

    function frame(now) {
        const dt = Math.min(0.05, (now - lastT) / 1000);
        lastT = now;
        acc += dt;

        const k = 1 - Math.pow(0.001, dt);
        state.cloud += (target.cloud - state.cloud) * k;
        state.rain  += (target.rain  - state.rain)  * k;
        state.haze  += (target.haze  - state.haze)  * k;

        const realTod = laTimeOfDay();
        if (mode === 'auto') target.tod = realTod;
        else if (PRESETS[mode]) target.tod = PRESETS[mode].forceTime ?? realTod;
        state.displayTod = lerpAngle(state.displayTod, target.tod, k);
        const tod = state.displayTod;

        const dayPhase = Math.max(0, Math.min(1, (tod - 0.25) / 0.5));
        const sunAlt = (tod > 0.25 && tod < 0.75) ? Math.sin(dayPhase * Math.PI) : 0;
        const sunUvX = 0.15 + dayPhase * 0.7;
        const sunUvY = 0.55 + sunAlt * 0.40;
        sun.position.set((sunUvX - 0.5) * 2 * aspect, (sunUvY - 0.5) * 2, 0);
        sunMat.uniforms.uOpacity.value = sunAlt;
        sunMat.uniforms.uTime.value = acc;

        let nightPhase;
        if (tod >= 0.78) nightPhase = (tod - 0.78) / 0.44;
        else if (tod <= 0.22) nightPhase = (tod + 0.22) / 0.44;
        else nightPhase = 0.5;
        nightPhase = Math.max(0, Math.min(1, nightPhase));
        const moonAlt = Math.sin(nightPhase * Math.PI);
        const moonUvX = 0.18 + nightPhase * 0.64;
        const moonUvY = 0.55 + moonAlt * 0.40;
        moon.position.set((moonUvX - 0.5) * 2 * aspect, (moonUvY - 0.5) * 2, 0);

        const night = sunAlt < 0.02 ? 1.0 : Math.max(0, 1 - sunAlt * 3.0);
        // Toggle body class for day/night text colors (driven by real sun altitude)
        const isDay = sunAlt > 0.30;
        if (isDay !== document.body.classList.contains('is-day')) {
            document.body.classList.toggle('is-day', isDay);
            document.body.classList.toggle('is-night', !isDay);
        }
        // Wind sway — palms shake harder during rain
        const isRaining = state.rain > 0.05;
        if (isRaining !== document.body.classList.contains('is-raining')) {
            document.body.classList.toggle('is-raining', isRaining);
        }
        moonMat.uniforms.uPhase.value = moonPhase();
        moonMat.uniforms.uOpacity.value = night;
        starMat.uniforms.uOpacity.value = night;
        starMat.uniforms.uTime.value = acc;

        const pal = paletteAt(tod);
        skyMat.uniforms.uTime.value = acc;
        skyMat.uniforms.uTopColor.value.setRGB(pal.top[0], pal.top[1], pal.top[2]);
        skyMat.uniforms.uBotColor.value.setRGB(pal.bot[0], pal.bot[1], pal.bot[2]);
        skyMat.uniforms.uCloud.value = state.cloud;
        skyMat.uniforms.uRain.value = state.rain;
        skyMat.uniforms.uHaze.value = state.haze;
        skyMat.uniforms.uSunAlt.value = sunAlt;
        skyMat.uniforms.uSunUv.value.set(sunUvX, sunUvY);
        skyMat.uniforms.uNight.value = night;

        // Render Three.js sky to its offscreen WebGL canvas
        renderer.render(scene, camera);

        // Mirror the WebGL canvas into the 2D proxy so raindrop-fx can read it cleanly
        if (proxyCanvas.width > 0 && proxyCanvas.height > 0) {
            proxyCtx.drawImage(skyCanvas, 0, 0, proxyCanvas.width, proxyCanvas.height);
        }

        // Drive raindrop-fx options from current rain intensity, and refresh its background
        if (raindropFx) {
            const r = state.rain;
            if (r < 0.02) {
                // No meaningful rain — stop spawning entirely
                raindropFx.options.dropletsPerSeconds = 0;
                raindropFx.options.spawnInterval = [9999, 9999];
            } else {
                // Mobile: ~half the drop budget so GPU fill stays manageable
                const dropMul = isMobile ? 0.5 : 1.0;
                raindropFx.options.dropletsPerSeconds = r * 3200 * dropMul;
                const baseInterval = isMobile ? 0.028 : 0.018;
                raindropFx.options.spawnInterval = [
                    baseInterval / r,
                    (baseInterval * 2.2) / r,
                ];
                raindropFx.options.spawnSize = [55 + r * 40, 130 + r * 90];
            }

            // Re-upload the proxy canvas as the raindrop-fx background each frame.
            // For canvas inputs reloadBackground is effectively sync; we just don't await.
            try {
                raindropFx.renderer.options.background = proxyCanvas;
                raindropFx.renderer.reloadBackground();
            } catch (_) {}
        }

        if (running && !reduceMotion) requestAnimationFrame(frame);
    }

    document.addEventListener('visibilitychange', () => {
        running = !document.hidden;
        if (running && !reduceMotion) {
            lastT = performance.now();
            requestAnimationFrame(frame);
        }
    });

    if (reduceMotion) {
        requestAnimationFrame(t => { lastT = t; frame(t); });
    } else {
        requestAnimationFrame(frame);
    }

    // ---------- raindrop-fx (real rain on glass) ----------
    try {
        // Seed: render Three.js once and copy into the proxy canvas so
        // raindrop-fx has actual content to read at construction time.
        renderer.render(scene, camera);
        proxyCtx.drawImage(skyCanvas, 0, 0, proxyCanvas.width, proxyCanvas.height);

        visibleCanvas.width = window.innerWidth;
        visibleCanvas.height = window.innerHeight;

        raindropFx = new RaindropFX({
            canvas: visibleCanvas,
            background: proxyCanvas,
            backgroundBlurSteps: isMobile ? 0 : 1,
            mist: false,
            mistBlurStep: 0,
            spawnSize: isMobile ? [55, 120] : [70, 155],
            spawnLimit: isMobile ? 650 : 1400,
            dropletsPerSeconds: 0,
            spawnInterval: [0.03, 0.10],
            // ---- realism: shiny drops with bright highlights ----
            raindropDiffuseLight:    [0.65, 0.65, 0.70],
            raindropSpecularLight:   [2.00, 2.00, 2.10],
            raindropSpecularShininess: 220,
            raindropLightBump: 2.0,
            raindropLightPos: [-0.8, 1.0, 1.6, 0],
            refractBase: 0.58,
            refractScale: 1.00,
            // longer trails so the slide looks alive
            trailDropDensity: 0.55,
            trailDistance: [22, 50],
            trailDropSize: [0.40, 0.65],
            gravity: 3000,
        });
        await raindropFx.start();
    } catch (e) {
        console.warn('raindrop-fx init failed', e);
    }
})();
