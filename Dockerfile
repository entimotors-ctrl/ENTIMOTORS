FROM php:8.2-apache

# Instalamos extensiones para tu base de datos
RUN docker-php-ext-install mysqli pdo pdo_mysql

# Copiamos todos tus archivos
COPY . /var/www/html/

# Damos los permisos necesarios para el panel de administración
RUN chown -R www-data:www-data /var/www/html \
    && chmod -R 755 /var/www/html

# --- EL TRUCO PARA EL PUERTO EN RENDER ---
# Forzamos a Apache a usar la variable de entorno PORT que da Render
RUN sed -i 's/80/${PORT}/g' /etc/apache2/sites-available/000-default.conf /etc/apache2/ports.conf

# Comando para iniciar Apache en primer plano
CMD ["apache2-foreground"]
