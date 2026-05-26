const BASE = '/api';
let allProjects = [];
let currentFilter = 'all';

// ---- PROYECTOS ----
async function loadProjects() {
    try {
        const r = await fetch(`${BASE}/projects`);
        allProjects = await r.json();
        renderProjects();
    } catch {
        document.getElementById('projects-grid').innerHTML =
            '<p class="text-gray-600 col-span-3 text-center py-12 font-teko text-2xl">Error al cargar proyectos.</p>';
    }
}

function renderProjects() {
    const grid = document.getElementById('projects-grid');
    const empty = document.getElementById('projects-empty');
    const filtered = currentFilter === 'all'
        ? allProjects
        : allProjects.filter(p => p.status === currentFilter);

    if (!filtered.length) {
        grid.innerHTML = '';
        empty.classList.remove('hidden');
        return;
    }
    empty.classList.add('hidden');

    const colors = { en_curso: 'bg-red-600', terminado: 'bg-green-600' };
    const labels = { en_curso: 'En Curso', terminado: 'Terminado' };

    grid.innerHTML = filtered.map(p => {
        const imgs = (p.project_images && p.project_images.length > 0)
            ? p.project_images.map(i => i.image_url)
            : (p.image ? [p.image] : []);
        const cover = imgs[0] || '';
        const photoCount = imgs.length;
        return `
        <div class="glass-panel overflow-hidden group card-hover cursor-pointer" onclick="openProjectGallery(${p.id})">
            <div class="h-64 overflow-hidden relative">
                <img src="${cover}" alt="${p.title}"
                     class="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110" loading="lazy">
                <div class="absolute top-4 right-4 ${colors[p.status] || 'bg-gray-600'} text-[10px] font-black px-2 py-1 rounded uppercase">
                    ${labels[p.status] || p.status}
                </div>
                ${photoCount > 1 ? `<div class="absolute bottom-3 right-3 bg-black/60 text-white text-[10px] font-bold px-2 py-1 rounded-full flex items-center gap-1" style="font-family:'Teko',sans-serif; letter-spacing:0.05em;">
                    <svg xmlns="http://www.w3.org/2000/svg" style="width:12px;height:12px;" fill="currentColor" viewBox="0 0 20 20"><path d="M4 3a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V5a2 2 0 00-2-2H4zm12 12H4l4-8 3 6 2-4 3 6z"/></svg>
                    ${photoCount}
                </div>` : ''}
            </div>
            <div class="p-6">
                <h3 class="text-2xl font-teko uppercase text-white">${p.title}</h3>
            </div>
        </div>`;
    }).join('');
}

function filterProjects(status, btn) {
    currentFilter = status;
    renderProjects();
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
}

// ---- VIDEOS ----
async function loadVideos() {
    const grid = document.getElementById('videos-grid');
    const empty = document.getElementById('videos-empty');
    try {
        const r = await fetch(`${BASE}/videos`);
        const data = await r.json();
        if (!data.length) {
            grid.innerHTML = '';
            empty.classList.remove('hidden');
            return;
        }
        empty.classList.add('hidden');
        
        // Aquí ocurre la magia para adaptar los tamaños automáticamente
        grid.innerHTML = data.map(v => {
            const urlLower = v.url.toLowerCase();
            // TikTok es vertical 9:16; YouTube y Facebook son horizontal 16:9
            const isTikTok = urlLower.includes('tiktok');
            const aspectRatio = isTikTok ? '177.77%' : '56.25%';
            // Facebook requiere allow="encrypted-media" y scrolling="no"
            const isFacebook = urlLower.includes('facebook.com');
            const extraAttrs = isFacebook
                ? 'scrolling="no" allow="autoplay; clipboard-write; encrypted-media; picture-in-picture; web-share"'
                : 'allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"';

            return `
            <div class="glass-panel card-hover overflow-hidden flex flex-col h-full">
                <div style="position:relative; padding-bottom:${aspectRatio}; height:0;">
                    <iframe src="${v.url}" title="${v.title}" frameborder="0"
                        ${extraAttrs}
                        allowfullscreen
                        style="position:absolute; top:0; left:0; width:100%; height:100%;"></iframe>
                </div>
                <div class="p-4 mt-auto">
                    <h3 class="font-teko text-xl uppercase text-white">${v.title}</h3>
                </div>
            </div>
            `;
        }).join('');
    } catch {
        document.getElementById('videos-grid').innerHTML = '<p class="text-gray-600 col-span-3 text-center py-12 font-teko text-2xl">Error al cargar videos.</p>';
    }
}

// ---- GALERÍA / LIGHTBOX ----
let galleryImages = [];
let galleryIdx = 0;

function openProjectGallery(projectId) {
    const p = allProjects.find(x => x.id === projectId);
    if (!p) return;
    const imgs = (p.project_images && p.project_images.length > 0)
        ? p.project_images.map(i => i.image_url)
        : (p.image ? [p.image] : []);
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

    thumbs.innerHTML = galleryImages.map((src, i) => `
        <img src="${src}" onclick="lbGoTo(${i})"
             style="width:52px; height:52px; object-fit:cover; border-radius:6px; cursor:pointer; flex-shrink:0;
                    border:2px solid ${i === galleryIdx ? '#e11d48' : 'transparent'};
                    opacity:${i === galleryIdx ? '1' : '0.45'}; transition:opacity 0.2s, border-color 0.2s;">`
    ).join('');

    // Scroll active thumb into view
    const activThumb = thumbs.children[galleryIdx];
    if (activThumb) activThumb.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
}

function lbNav(dir) {
    galleryIdx = (galleryIdx + dir + galleryImages.length) % galleryImages.length;
    renderGallery();
}

function lbGoTo(idx) {
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
// Estas son las órdenes que le dicen a la página que empiece a buscar la información
loadProjects();
loadVideos();
