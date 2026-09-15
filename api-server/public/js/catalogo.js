const BASE = '/api';
// Los datos de /api se pintan con nodos y textContent (js/seguro.js), nunca como HTML.
const { crear, texto, tiene, urlImagen } = window.EntiSeguro;
let allProducts = [];
let activeCategory = 'all';
let activeSearch = '';

// ---- PRODUCTOS ----
async function loadProducts() {
    const grid = document.getElementById('products-grid');
    const empty = document.getElementById('products-empty');
    try {
        const r = await fetch(`${BASE}/products`);
        const data = await r.json();
        allProducts = Array.isArray(data) ? data : [];
        if (!allProducts.length) {
            grid.replaceChildren();
            empty.classList.remove('hidden');
            return;
        }
        renderProducts();
    } catch {
        document.getElementById('products-grid').replaceChildren(
            crear('p', { clase: 'text-gray-600 col-span-4 text-center py-12 font-teko text-2xl', texto: 'Error al cargar productos.' }));
    }
}

const INSIGNIAS = {
    repuesto: { clase: 'text-[9px] font-black uppercase tracking-widest bg-red-600/20 text-red-400 border border-red-600/30 px-2 py-0.5 rounded-full', texto: 'Repuesto' },
    accesorio: { clase: 'text-[9px] font-black uppercase tracking-widest bg-purple-600/20 text-purple-400 border border-purple-600/30 px-2 py-0.5 rounded-full', texto: 'Accesorio' },
};

function tarjetaProducto(p) {
    const nombre = texto(p.name);
    const src = urlImagen(p.image);
    const marco = crear('div', { clase: 'aspect-square mb-3 bg-white/5 rounded-lg flex items-center justify-center overflow-hidden' });
    if (src) {
        const img = crear('img', { clase: 'w-full h-full object-cover group-hover:scale-110 transition-transform cursor-pointer', attrs: { loading: 'lazy' } });
        img.alt = nombre;
        img.src = src;
        img.addEventListener('click', () => openLightbox(src));
        marco.append(img);
    } else {
        marco.append(crear('div', { clase: 'text-5xl text-white/10', texto: '🔧' }));
    }
    const insignia = tiene(INSIGNIAS, p.category) ? INSIGNIAS[p.category] : INSIGNIAS.repuesto;
    const consultar = crear('a', {
        clase: 'mt-3 w-full py-2 block bg-white/10 hover:bg-white hover:text-black text-[10px] font-black uppercase tracking-widest rounded transition-all',
        texto: 'Consultar',
        attrs: { target: '_blank', rel: 'noopener' },
    });
    consultar.href = 'https://wa.me/50497049635?text=Hola%20ENTIMOTORS,%20me%20interesa%20el%20producto:%20' + encodeURIComponent(nombre);
    return crear('div', { clase: 'glass-panel p-4 card-hover text-center relative group' }, [
        marco,
        crear('div', { clase: 'mb-1' }, [crear('span', insignia)]),
        crear('h4', { clase: 'font-teko text-xl uppercase tracking-wider mt-1', texto: nombre }),
        crear('p', { clase: 'text-red-500 font-bold text-lg', texto: `L. ${parseFloat(p.price).toFixed(2)}` }),
        consultar,
    ]);
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
        list = list.filter(p => texto(p.name).toLowerCase().includes(activeSearch));
    }

    if (!allProducts.length) {
        grid.replaceChildren();
        empty.classList.remove('hidden');
        noResults.classList.add('hidden');
        return;
    }

    if (!list.length) {
        grid.replaceChildren();
        noResults.classList.remove('hidden');
        empty.classList.add('hidden');
        return;
    }

    noResults.classList.add('hidden');
    empty.classList.add('hidden');

    grid.replaceChildren(...list.map(tarjetaProducto));
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

loadProducts();
