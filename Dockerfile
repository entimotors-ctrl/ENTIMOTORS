# Usamos una imagen oficial de PHP con Apache
FROM php:8.2-apache

# Instalamos extensiones comunes de PHP (por si tu panel las usa)
RUN docker-php-ext-install mysqli pdo pdo_mysql

# Copiamos todos tus archivos al servidor
COPY . /var/www/html/

# Damos permisos para que el panel pueda subir fotos y videos
RUN chown -R www-data:www-data /var/www/html && chmod -R 755 /var/www/html

# Le decimos a Apache que escuche en el puerto que Render usa
RUN sed -i 's/80/${PORT}/g' /etc/apache2/sites-available/000-default.conf /etc/apache2/ports.conf

# Exponemos el puerto
EXPOSE 80
