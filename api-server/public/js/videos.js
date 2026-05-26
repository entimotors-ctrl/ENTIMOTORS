const BASE = '/api';

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

        grid.innerHTML = data.map(v => {
            const urlLower = v.url.toLowerCase();
            const isTikTok   = urlLower.includes('tiktok');
            const isFacebook = urlLower.includes('facebook.com');

            // TikTok = vertical 9:16 | YouTube y Facebook = horizontal 16:9
            const aspectRatio = isTikTok ? '177.77%' : '56.25%';

            // Facebook necesita permisos extra
            const extraAttrs = isFacebook
                ? 'scrolling="no" allow="autoplay; clipboard-write; encrypted-media; picture-in-picture; web-share"'
                : 'allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"';

            // Icono de play para el placeholder mientras carga
            const playIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" fill="white" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`;

            return `
            <div class="glass-panel card-hover overflow-hidden flex flex-col h-full">
                <div style="position:relative; padding-bottom:${aspectRatio}; height:0;">
                    <!-- iframe usa data-src; el IntersectionObserver pone el src real cuando es visible -->
                    <iframe
                        data-src="${v.url}"
                        title="${v.title}"
                        frameborder="0"
                        ${extraAttrs}
                        allowfullscreen
                        loading="lazy"
                        style="position:absolute; top:0; left:0; width:100%; height:100%; opacity:0; transition:opacity 0.4s;">
                    </iframe>
                    <!-- Placeholder shimmer mientras el iframe no ha cargado -->
                    <div class="iframe-placeholder">
                        ${playIcon}
                    </div>
                </div>
                <div class="p-4 mt-auto">
                    <h3 class="font-teko text-xl uppercase text-white">${v.title}</h3>
                </div>
            </div>`;
        }).join('');

        // Intersection Observer: activa src del iframe solo cuando entra en pantalla
        // rootMargin 300px: empieza a cargar un poco antes de que sea visible
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (!entry.isIntersecting) return;
                const iframe = entry.target;
                if (iframe.dataset.src) {
                    iframe.src = iframe.dataset.src;
                    delete iframe.dataset.src;
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
        document.getElementById('videos-grid').innerHTML =
            '<p class="text-gray-600 col-span-3 text-center py-12 font-teko text-2xl">Error al cargar videos.</p>';
    }
}

loadVideos();
