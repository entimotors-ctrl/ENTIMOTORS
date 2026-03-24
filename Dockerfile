FROM php:8.2-apache

# Instalamos extensiones necesarias para bases de datos
RUN docker-php-ext-install mysqli pdo pdo_mysql

# Copiamos TODO el repositorio (incluyendo ENTIMOTORS y api-server)
COPY . /var/www/html/

# --- CONFIGURACIÓN DE RUTAS ---
# Le decimos a Apache que la página principal está dentro de /ENTIMOTORS
ENV APACHE_DOCUMENT_ROOT /var/www/html/ENTIMOTORS
RUN sed -ri -e 's!/var/www/html!${APACHE_DOCUMENT_ROOT}!g' /etc/apache2/sites-available/000-default.conf
RUN sed -ri -e 's!/var/www/html!${APACHE_DOCUMENT_ROOT}!g' /etc/apache2/apache2.conf

# --- PERMISOS PARA SUBIR ARCHIVOS ---
# Damos permisos a todo, especialmente a api-server/uploads (o donde guardes los videos)
RUN chown -R www-data:www-data /var/www/html \
    && chmod -R 775 /var/www/html

# Ajuste de puerto para Render
RUN sed -i 's/80/${PORT}/g' /etc/apache2/sites-available/000-default.conf /etc/apache2/ports.conf

EXPOSE 80

CMD ["apache2-foreground"]
