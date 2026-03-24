FROM php:8.2-apache

# 1. Instalamos extensiones de PHP
RUN docker-php-ext-install mysqli pdo pdo_mysql

# 2. Copiamos TODO el contenido de tu GitHub al servidor
COPY . /var/www/html/

# 3. MOVER ARCHIVOS (Si están dentro de ENTIMOTORS, los sacamos a la raíz)
# Esto evita el error 404 porque pone el index.html donde Apache lo busca sí o sí.
RUN if [ -d "/var/www/html/ENTIMOTORS" ]; then cp -r /var/www/html/ENTIMOTORS/* /var/www/html/; fi

# 4. Permisos para que el panel funcione
RUN chown -R www-data:www-data /var/www/html && chmod -R 755 /var/www/html

# 5. Configuración de puerto para Render
RUN sed -i 's/80/${PORT}/g' /etc/apache2/sites-available/000-default.conf /etc/apache2/ports.conf

EXPOSE 80

CMD ["apache2-foreground"]
