const BASE = '/api';
// Los datos de /api se pintan con nodos y textContent (js/seguro.js), nunca como HTML.
const { crear, crearSvg, texto, tiene, urlImagen } = window.EntiSeguro;
let allProjects = [];
let currentFilter = 'all';

// ---- PROYECTOS ----
async function loadProjects() {
    try {
        const r = await fetch(`${BASE}/projects`);
        const data = await r.json();
        allProjects = Array.isArray(data) ? data : [];
        renderProjects();
    } catch {
        document.getElementById('projects-grid').replaceChildren(
            crear('p', { clase: 'text-gray-600 col-span-3 text-center py-12 font-teko text-2xl', texto: 'Error al cargar proyectos.' }));
    }
}

// Fotos del proyecto que se pueden mostrar (las URLs no válidas se descartan)
function imagenesDe(p) {
    const fuentes = Array.isArray(p.project_images) && p.project_images.length > 0
        ? p.project_images.map(i => i && i.image_url)
        : (p.image ? [p.image] : []);
    return fuentes.map(urlImagen).filter(Boolean);
}

const COLORES = { en_curso: 'bg-red-600', terminado: 'bg-green-600' };
const ETIQUETAS = { en_curso: 'En Curso', terminado: 'Terminado' };
const ICONO_FOTOS = 'M4 3a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V5a2 2 0 00-2-2H4zm12 12H4l4-8 3 6 2-4 3 6z';

function tarjetaProyecto(p) {
    const titulo = texto(p.title);
    const imgs = imagenesDe(p);
    const cabecera = crear('div', { clase: 'h-64 overflow-hidden relative' });
    if (imgs.length) {
        const img = crear('img', { clase: 'w-full h-full object-cover transition-transform duration-700 group-hover:scale-110', attrs: { loading: 'lazy' } });
        img.alt = titulo;
        img.src = imgs[0];
        cabecera.append(img);
    } else {
        cabecera.append(crear('div', { clase: 'w-full h-full bg-white/5' }));
    }
    const color = tiene(COLORES, p.status) ? COLORES[p.status] : 'bg-gray-600';
    const etiqueta = tiene(ETIQUETAS, p.status) ? ETIQUETAS[p.status] : texto(p.status);
    cabecera.append(crear('div', { clase: `absolute top-4 right-4 ${color} text-[10px] font-black px-2 py-1 rounded uppercase`, texto: etiqueta }));
    if (imgs.length > 1) {
        const contador = crear('div', { clase: 'absolute bottom-3 right-3 bg-black/60 text-white text-[10px] font-bold px-2 py-1 rounded-full flex items-center gap-1' }, [
            crearSvg('0 0 20 20', ICONO_FOTOS, null, 'width:12px;height:12px;'),
            document.createTextNode(String(imgs.length)),
        ]);
        contador.style.fontFamily = "'Teko',sans-serif";
        contador.style.letterSpacing = '0.05em';
        cabecera.append(contador);
    }
    const tarjeta = crear('div', { clase: 'glass-panel overflow-hidden group card-hover cursor-pointer' }, [
        cabecera,
        crear('div', { clase: 'p-6' }, [crear('h3', { clase: 'text-2xl font-teko uppercase text-white', texto: titulo })]),
    ]);
    // el proyecto viaja en el closure: su id nunca se escribe en un handler ni en HTML
    tarjeta.addEventListener('click', () => openProjectGallery(p));
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

// ---- GALERÍA / LIGHTBOX ----
let galleryImages = [];
let galleryIdx = 0;

function openProjectGallery(proyecto) {
    if (!proyecto || typeof proyecto !== 'object') return;
    const imgs = imagenesDe(proyecto);
    if (!imgs.length) return;
    galleryImages = imgs;
    galleryIdx = 0;
    document.getElementById('lightbox').style.display = 'block';
    renderGallery();
}

function renderGallery() {
    const img = document.getElementById('lightbox-img');
    const counter = document.getElementById('lb-counter');
    const thumbs = document.getElementById('lb-thumbs');
    const prev = document.getElementById('lb-prev');
    const next = document.getElementById('lb-next');

    img.src = galleryImages[galleryIdx];
    counter.textContent = galleryImages.length > 1 ? `${galleryIdx + 1} / ${galleryImages.length}` : '';

    const showNav = galleryImages.length > 1;
    prev.style.visibility = showNav ? 'visible' : 'hidden';
    next.style.visibility = showNav ? 'visible' : 'hidden';

    thumbs.replaceChildren(...galleryImages.map((src, i) => {
        const mini = document.createElement('img');
        mini.src = src;
        mini.style.cssText = 'width:52px; height:52px; object-fit:cover; border-radius:6px; cursor:pointer; flex-shrink:0; transition:opacity 0.2s, border-color 0.2s;';
        mini.style.border = `2px solid ${i === galleryIdx ? '#e11d48' : 'transparent'}`;
        mini.style.opacity = i === galleryIdx ? '1' : '0.45';
        mini.addEventListener('click', () => lbGoTo(i));
        return mini;
    }));

    // Scroll active thumb into view
    const activThumb = thumbs.children[galleryIdx];
    if (activThumb) activThumb.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
}

function lbNav(dir) {
    if (!galleryImages.length) return;
    galleryIdx = (galleryIdx + dir + galleryImages.length) % galleryImages.length;
    renderGallery();
}

function lbGoTo(idx) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= galleryImages.length) return;
    galleryIdx = idx;
    renderGallery();
}

function closeLightbox() {
    document.getElementById('lightbox').style.display = 'none';
    galleryImages = [];
}

// Teclado: flechas y Escape
document.addEventListener('keydown', (e) => {
    if (document.getElementById('lightbox').style.display === 'none') return;
    if (e.key === 'ArrowRight') lbNav(1);
    else if (e.key === 'ArrowLeft') lbNav(-1);
    else if (e.key === 'Escape') closeLightbox();
});

// ---- INICIALIZAR LA PÁGINA ----
loadProjects();
