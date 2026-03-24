FROM php:8.2-apache

# Instalamos extensiones para la base de datos
RUN docker-php-ext-install mysqli pdo pdo_mysql

# Copiamos todo el contenido (ENTIMOTORS y api-server)
COPY . /var/www/html/

# --- CONFIGURACIÓN DE ACCESO ---
# Le decimos a Apache que la web principal está en ENTIMOTORS
ENV APACHE_DOCUMENT_ROOT /var/www/html/ENTIMOTORS
RUN sed -ri -e 's!/var/www/html!${APACHE_DOCUMENT_ROOT}!g' /etc/apache2/sites-available/000-default.conf
RUN sed -ri -e 's!/var/www/html!${APACHE_DOCUMENT_ROOT}!g' /etc/apache2/apache2.conf

# Habilitamos que Apache reconozca index.html e index.php
RUN echo "DirectoryIndex index.html index.php" >> /etc/apache2/apache2.conf

# --- PERMISOS DE ESCRITURA ---
# Damos permisos a todo el proyecto para que el panel pueda subir archivos
RUN chown -R www-data:www-data /var/www/html \
    && chmod -R 775 /var/www/html

# Ajuste de puerto para Render
RUN sed -i 's/80/${PORT}/g' /etc/apache2/sites-available/000-default.conf /etc/apache2/ports.conf

EXPOSE 80

CMD ["apache2-foreground"]
