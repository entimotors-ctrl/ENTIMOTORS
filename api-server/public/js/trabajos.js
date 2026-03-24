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

    grid.innerHTML = filtered.map(p => `
        <div class="glass-panel overflow-hidden group card-hover cursor-pointer" onclick="openLightbox('${p.image}')">
            <div class="h-64 overflow-hidden relative">
                <img src="${p.image}" alt="${p.title}"
                     class="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110" loading="lazy">
                <div class="absolute top-4 right-4 ${colors[p.status] || 'bg-gray-600'} text-[10px] font-black px-2 py-1 rounded uppercase">
                    ${labels[p.status] || p.status}
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
                    <iframe src="${v.url}" title="${v.title}" frameborder="0"
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                        allowfullscreen
                        style="position:absolute; top:0; left:0; width:100%; height:100%;"></iframe>
                </div>
                <div class="p-4">
                    <h3 class="font-teko text-xl uppercase text-white">${v.title}</h3>
                </div>
            </div>
        `).join('');
    } catch {
        grid.innerHTML = '<p class="text-gray-600 col-span-3 text-center py-12 font-teko text-2xl">Error al cargar videos.</p>';
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

loadProjects();
loadVideos();
