const BASE = '/api';
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

// ---- PROYECTOS ----
async function loadProjects() {
    try {
        const r = await fetch(`${BASE}/projects`);
        allProjects = await r.json();
        renderProjects();
    } catch {
        document.getElementById('projects-grid').innerHTML =
            '<p class="text-gray-600 col-span-3 text-center py-12">Error al cargar proyectos.</p>';
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

    const statusColors = { en_curso: 'bg-red-600', terminado: 'bg-green-600' };
    const statusLabels = { en_curso: 'En Curso', terminado: 'Terminado' };

    grid.innerHTML = filtered.map(p => `
        <div class="glass-panel overflow-hidden group card-hover cursor-pointer" onclick="openLightbox('${p.image}')">
            <div class="h-64 overflow-hidden relative">
                <img src="${p.image}" alt="${p.title}"
                     class="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110"
                     loading="lazy">
                <div class="absolute top-4 right-4 ${statusColors[p.status] || 'bg-gray-600'} text-[10px] font-black px-2 py-1 rounded uppercase">
                    ${statusLabels[p.status] || p.status}
                </div>
            </div>
            <div class="p-6">
                <h3 class="text-2xl font-teko uppercase text-white">${p.title}</h3>
            </div>
        </div>
    `).join('');
}

function filterProjects(status, btn) {
    currentFilter = status;
    renderProjects();
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
}

// ---- CATÁLOGO / PRODUCTOS ----
async function loadProducts() {
    const grid = document.getElementById('products-grid');
    const empty = document.getElementById('products-empty');
    try {
        const r = await fetch(`${BASE}/products`);
        const data = await r.json();

        if (!data.length) {
            grid.innerHTML = '';
            empty.classList.remove('hidden');
            return;
        }
        empty.classList.add('hidden');

        grid.innerHTML = data.map(p => `
            <div class="glass-panel p-4 card-hover text-center relative group">
                <div class="aspect-square mb-4 bg-white/5 rounded-lg flex items-center justify-center overflow-hidden">
                    ${p.image
                        ? `<img src="${p.image}" alt="${p.name}"
                                class="w-full h-full object-cover group-hover:scale-110 transition-transform cursor-pointer"
                                onclick="openLightbox('${p.image}')" loading="lazy">`
                        : `<div class="text-5xl text-white/10">🔧</div>`
                    }
                </div>
                <h4 class="font-teko text-xl uppercase tracking-wider">${p.name}</h4>
                <p class="text-red-500 font-bold">L. ${parseFloat(p.price).toFixed(2)}</p>
                <a href="https://wa.me/50497049635?text=Hola%20ENTIMOTORS,%20me%20interesa%20el%20producto:%20${encodeURIComponent(p.name)}"
                   target="_blank"
                   class="mt-4 w-full py-2 block bg-white/10 hover:bg-white hover:text-black text-[10px] font-black uppercase tracking-widest rounded transition-all">
                    Consultar
                </a>
            </div>
        `).join('');
    } catch {
        grid.innerHTML = '<p class="text-gray-600 col-span-4 text-center py-12">Error al cargar productos.</p>';
    }
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

        grid.innerHTML = data.map(v => `
            <div class="glass-panel card-hover overflow-hidden">
                <div style="position:relative; padding-bottom:56.25%; height:0;">
                    <iframe
                        src="${v.url}"
                        title="${v.title}"
                        frameborder="0"
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                        allowfullscreen
                        style="position:absolute; top:0; left:0; width:100%; height:100%;">
                    </iframe>
                </div>
                <div class="p-4">
                    <h3 class="font-teko text-xl uppercase text-white">${v.title}</h3>
                </div>
            </div>
        `).join('');
    } catch {
        grid.innerHTML = '<p class="text-gray-600 col-span-3 text-center py-12">Error al cargar videos.</p>';
    }
}

// ---- LIGHTBOX ----
function openLightbox(src) {
    const lb = document.getElementById('lightbox');
    document.getElementById('lightbox-img').src = src;
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
