const BASE = '/api';
// Los datos de /api se pintan con nodos y textContent (js/seguro.js, que debe cargarse antes), nunca como HTML.
const { crear, texto, tiene, urlImagen, urlVideo } = window.EntiSeguro;
let allProjects = [];
let currentFilter = 'all';

// ---- MOBILE MENU ----
document.getElementById('menu-btn')?.addEventListener('click', () => {
    const menu = document.getElementById('mobile-menu');
    menu.classList.toggle('hidden');
    menu.classList.toggle('flex');
});

function closeMobileMenu() {
    const menu = document.getElementById('mobile-menu');
    menu.classList.add('hidden');
    menu.classList.remove('flex');
}

const errorCarga = (clase, mensaje) => crear('p', { clase, texto: mensaje });

// ---- PROYECTOS ----
async function loadProjects() {
    try {
        const r = await fetch(`${BASE}/projects`);
        const data = await r.json();
        allProjects = Array.isArray(data) ? data : [];
        renderProjects();
    } catch {
        document.getElementById('projects-grid').replaceChildren(
            errorCarga('text-gray-600 col-span-3 text-center py-12', 'Error al cargar proyectos.'));
    }
}

const COLORES = { en_curso: 'bg-red-600', terminado: 'bg-green-600' };
const ETIQUETAS = { en_curso: 'En Curso', terminado: 'Terminado' };

function tarjetaProyecto(p) {
    const titulo = texto(p.title);
    const src = urlImagen(p.image);
    const cabecera = crear('div', { clase: 'h-64 overflow-hidden relative' });
    if (src) {
        const img = crear('img', { clase: 'w-full h-full object-cover transition-transform duration-700 group-hover:scale-110', attrs: { loading: 'lazy' } });
        img.alt = titulo;
        img.src = src;
        cabecera.append(img);
    } else {
        cabecera.append(crear('div', { clase: 'w-full h-full bg-white/5' }));
    }
    const color = tiene(COLORES, p.status) ? COLORES[p.status] : 'bg-gray-600';
    const etiqueta = tiene(ETIQUETAS, p.status) ? ETIQUETAS[p.status] : texto(p.status);
    cabecera.append(crear('div', { clase: `absolute top-4 right-4 ${color} text-[10px] font-black px-2 py-1 rounded uppercase`, texto: etiqueta }));
    const tarjeta = crear('div', { clase: 'glass-panel overflow-hidden group card-hover cursor-pointer' }, [
        cabecera,
        crear('div', { clase: 'p-6' }, [crear('h3', { clase: 'text-2xl font-teko uppercase text-white', texto: titulo })]),
    ]);
    tarjeta.addEventListener('click', () => openLightbox(src));
    return tarjeta;
}

function renderProjects() {
    const grid = document.getElementById('projects-grid');
    const empty = document.getElementById('projects-empty');
    const filtered = currentFilter === 'all'
        ? allProjects
        : allProjects.filter(p => p.status === currentFilter);

    if (!filtered.length) {
        grid.replaceChildren();
        empty.classList.remove('hidden');
        return;
    }
    empty.classList.add('hidden');
    grid.replaceChildren(...filtered.map(tarjetaProyecto));
}

function filterProjects(status, btn) {
    currentFilter = status;
    renderProjects();
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
}

// ---- CATÁLOGO / PRODUCTOS ----
function tarjetaProducto(p) {
    const nombre = texto(p.name);
    const src = urlImagen(p.image);
    const marco = crear('div', { clase: 'aspect-square mb-4 bg-white/5 rounded-lg flex items-center justify-center overflow-hidden' });
    if (src) {
        const img = crear('img', { clase: 'w-full h-full object-cover group-hover:scale-110 transition-transform cursor-pointer', attrs: { loading: 'lazy' } });
        img.alt = nombre;
        img.src = src;
        img.addEventListener('click', () => openLightbox(src));
        marco.append(img);
    } else {
        marco.append(crear('div', { clase: 'text-5xl text-white/10', texto: '🔧' }));
    }
    const consultar = crear('a', {
        clase: 'mt-4 w-full py-2 block bg-white/10 hover:bg-white hover:text-black text-[10px] font-black uppercase tracking-widest rounded transition-all',
        texto: 'Consultar',
        attrs: { target: '_blank', rel: 'noopener' },
    });
    consultar.href = 'https://wa.me/50497049635?text=Hola%20ENTIMOTORS,%20me%20interesa%20el%20producto:%20' + encodeURIComponent(nombre);
    return crear('div', { clase: 'glass-panel p-4 card-hover text-center relative group' }, [
        marco,
        crear('h4', { clase: 'font-teko text-xl uppercase tracking-wider', texto: nombre }),
        crear('p', { clase: 'text-red-500 font-bold', texto: `L. ${parseFloat(p.price).toFixed(2)}` }),
        consultar,
    ]);
}

async function loadProducts() {
    const grid = document.getElementById('products-grid');
    const empty = document.getElementById('products-empty');
    try {
        const r = await fetch(`${BASE}/products`);
        const data = await r.json();

        if (!Array.isArray(data) || !data.length) {
            grid.replaceChildren();
            empty.classList.remove('hidden');
            return;
        }
        empty.classList.add('hidden');
        grid.replaceChildren(...data.map(tarjetaProducto));
    } catch {
        grid.replaceChildren(errorCarga('text-gray-600 col-span-4 text-center py-12', 'Error al cargar productos.'));
    }
}

// ---- VIDEOS ----
function tarjetaVideo(v) {
    const titulo = texto(v.title);
    const video = urlVideo(v.url);
    const marco = crear('div');
    marco.style.cssText = 'position:relative; padding-bottom:56.25%; height:0;';
    if (video) {
        const iframe = document.createElement('iframe');
        iframe.title = titulo;
        iframe.setAttribute('frameborder', '0');
        iframe.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture');
        iframe.allowFullscreen = true;
        iframe.style.cssText = 'position:absolute; top:0; left:0; width:100%; height:100%;';
        iframe.src = video.src;
        marco.append(iframe);
    }
    return crear('div', { clase: 'glass-panel card-hover overflow-hidden' }, [
        marco,
        crear('div', { clase: 'p-4' }, [crear('h3', { clase: 'font-teko text-xl uppercase text-white', texto: titulo })]),
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
    } catch {
        grid.replaceChildren(errorCarga('text-gray-600 col-span-3 text-center py-12', 'Error al cargar videos.'));
    }
}

// ---- LIGHTBOX ----
function openLightbox(src) {
    const segura = urlImagen(src);
    if (!segura) return;
    const lb = document.getElementById('lightbox');
    document.getElementById('lightbox-img').src = segura;
    lb.style.display = 'flex';
}
function closeLightbox() {
    document.getElementById('lightbox').style.display = 'none';
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLightbox(); });

// ---- INIT ----
loadProjects();
loadProducts();
loadVideos();
