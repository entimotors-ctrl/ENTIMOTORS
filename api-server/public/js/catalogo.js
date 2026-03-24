const BASE = '/api';
let allProducts = [];
let activeCategory = 'all';
let activeSearch = '';

// ---- PRODUCTOS ----
async function loadProducts() {
    const grid = document.getElementById('products-grid');
    const empty = document.getElementById('products-empty');
    try {
        const r = await fetch(`${BASE}/products`);
        allProducts = await r.json();
        if (!allProducts.length) {
            grid.innerHTML = '';
            empty.classList.remove('hidden');
            return;
        }
        renderProducts();
    } catch {
        document.getElementById('products-grid').innerHTML =
            '<p class="text-gray-600 col-span-4 text-center py-12 font-teko text-2xl">Error al cargar productos.</p>';
    }
}

function renderProducts() {
    const grid = document.getElementById('products-grid');
    const empty = document.getElementById('products-empty');
    const noResults = document.getElementById('products-no-results');

    let list = allProducts;

    // Filtrar por categoría
    if (activeCategory !== 'all') {
        list = list.filter(p => p.category === activeCategory);
    }

    // Filtrar por búsqueda
    if (activeSearch) {
        list = list.filter(p => p.name.toLowerCase().includes(activeSearch));
    }

    if (!allProducts.length) {
        grid.innerHTML = '';
        empty.classList.remove('hidden');
        noResults.classList.add('hidden');
        return;
    }

    if (!list.length) {
        grid.innerHTML = '';
        noResults.classList.remove('hidden');
        empty.classList.add('hidden');
        return;
    }

    noResults.classList.add('hidden');
    empty.classList.add('hidden');

    const categoryBadge = {
        repuesto: '<span class="text-[9px] font-black uppercase tracking-widest bg-red-600/20 text-red-400 border border-red-600/30 px-2 py-0.5 rounded-full">Repuesto</span>',
        accesorio: '<span class="text-[9px] font-black uppercase tracking-widest bg-purple-600/20 text-purple-400 border border-purple-600/30 px-2 py-0.5 rounded-full">Accesorio</span>'
    };

    grid.innerHTML = list.map(p => `
        <div class="glass-panel p-4 card-hover text-center relative group">
            <div class="aspect-square mb-3 bg-white/5 rounded-lg flex items-center justify-center overflow-hidden">
                ${p.image
                    ? `<img src="${p.image}" alt="${p.name}"
                            class="w-full h-full object-cover group-hover:scale-110 transition-transform cursor-pointer"
                            onclick="openLightbox('${p.image}')" loading="lazy">`
                    : `<div class="text-5xl text-white/10">🔧</div>`
                }
            </div>
            <div class="mb-1">${categoryBadge[p.category] || categoryBadge.repuesto}</div>
            <h4 class="font-teko text-xl uppercase tracking-wider mt-1">${p.name}</h4>
            <p class="text-red-500 font-bold text-lg">L. ${parseFloat(p.price).toFixed(2)}</p>
            <a href="https://wa.me/50497049635?text=Hola%20ENTIMOTORS,%20me%20interesa%20el%20producto:%20${encodeURIComponent(p.name)}"
               target="_blank"
               class="mt-3 w-full py-2 block bg-white/10 hover:bg-white hover:text-black text-[10px] font-black uppercase tracking-widest rounded transition-all">
                Consultar
            </a>
        </div>
    `).join('');
}

function filterByCategory(cat, btn) {
    activeCategory = cat;
    renderProducts();
    document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
}

function searchProducts(query) {
    activeSearch = query.toLowerCase().trim();
    renderProducts();
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

loadProducts();
