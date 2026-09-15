const BASE = '/api';
// Los datos de /api se pintan con nodos y textContent (js/seguro.js), nunca como HTML.
// El iframe solo recibe un embed canónico reconstruido por urlVideo(); cualquier otra URL
// deja la tarjeta con el marcador y sin iframe.
const { crear, crearSvg, texto, urlVideo } = window.EntiSeguro;

const ICONO_PLAY = 'M8 5v14l11-7z';
const PERMISOS = {
    facebook: 'autoplay; clipboard-write; encrypted-media; picture-in-picture; web-share',
    otros: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture',
};

function tarjetaVideo(v) {
    const titulo = texto(v.title);
    const video = urlVideo(v.url);

    // TikTok = vertical 9:16 | YouTube y Facebook = horizontal 16:9
    const marco = crear('div');
    marco.style.cssText = `position:relative; padding-bottom:${video && video.tipo === 'tiktok' ? '177.77%' : '56.25%'}; height:0;`;

    // Placeholder shimmer mientras el iframe no ha cargado (o si el video no es válido)
    const icono = crearSvg('0 0 24 24', ICONO_PLAY);
    icono.setAttribute('width', '48');
    icono.setAttribute('height', '48');
    icono.setAttribute('fill', 'white');
    const placeholder = crear('div', { clase: 'iframe-placeholder' }, [icono]);

    if (video) {
        const iframe = document.createElement('iframe');
        iframe.title = titulo;
        iframe.setAttribute('frameborder', '0');
        iframe.setAttribute('allow', video.tipo === 'facebook' ? PERMISOS.facebook : PERMISOS.otros);
        if (video.tipo === 'facebook') iframe.setAttribute('scrolling', 'no');
        iframe.allowFullscreen = true;
        iframe.setAttribute('loading', 'lazy');
        iframe.style.cssText = 'position:absolute; top:0; left:0; width:100%; height:100%; opacity:0; transition:opacity 0.4s;';
        // el IntersectionObserver pone el src real cuando es visible
        iframe.dataset.src = video.src;
        marco.append(iframe, placeholder);
    } else {
        marco.append(placeholder);
    }

    return crear('div', { clase: 'glass-panel card-hover overflow-hidden flex flex-col h-full' }, [
        marco,
        crear('div', { clase: 'p-4 mt-auto' }, [crear('h3', { clase: 'font-teko text-xl uppercase text-white', texto: titulo })]),
    ]);
}

async function loadVideos() {
    const grid = document.getElementById('videos-grid');
    const empty = document.getElementById('videos-empty');
    try {
        const r = await fetch(`${BASE}/videos`);
        const data = await r.json();

        if (!Array.isArray(data) || !data.length) {
            grid.replaceChildren();
            empty.classList.remove('hidden');
            return;
        }
        empty.classList.add('hidden');

        grid.replaceChildren(...data.map(tarjetaVideo));

        // Intersection Observer: activa src del iframe solo cuando entra en pantalla
        // rootMargin 300px: empieza a cargar un poco antes de que sea visible
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (!entry.isIntersecting) return;
                const iframe = entry.target;
                const video = urlVideo(iframe.dataset.src);   // se vuelve a validar justo antes de asignar
                delete iframe.dataset.src;
                if (video) {
                    iframe.src = video.src;
                    // Mostrar iframe suavemente cuando termina de cargar
                    iframe.addEventListener('load', () => {
                        iframe.style.opacity = '1';
                        const placeholder = iframe.nextElementSibling;
                        if (placeholder && placeholder.classList.contains('iframe-placeholder')) {
                            placeholder.style.display = 'none';
                        }
                    }, { once: true });
                }
                observer.unobserve(iframe);
            });
        }, { rootMargin: '300px 0px', threshold: 0 });

        document.querySelectorAll('#videos-grid iframe[data-src]').forEach(iframe => {
            observer.observe(iframe);
        });

    } catch {
        document.getElementById('videos-grid').replaceChildren(
            crear('p', { clase: 'text-gray-600 col-span-3 text-center py-12 font-teko text-2xl', texto: 'Error al cargar videos.' }));
    }
}

loadVideos();
