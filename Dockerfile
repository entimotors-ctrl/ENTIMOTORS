FROM php:8.2-apache

# Instalamos extensiones de base de datos
RUN docker-php-ext-install mysqli pdo pdo_mysql

# Copiamos todo tu código al servidor
COPY . /var/www/html/

# Le decimos a Apache que la web pública está dentro de api-server/public
ENV APACHE_DOCUMENT_ROOT /var/www/html/api-server/public
RUN sed -ri -e 's!/var/www/html!${APACHE_DOCUMENT_ROOT}!g' /etc/apache2/sites-available/000-default.conf
RUN sed -ri -e 's!/var/www/html!${APACHE_DOCUMENT_ROOT}!g' /etc/apache2/apache2.conf

# Damos permisos
RUN chown -R www-data:www-data /var/www/html && chmod -R 775 /var/www/html

# Le decimos a la máquina que el puerto interno es el 80
EXPOSE 80

CMD ["apache2-foreground"]
