FROM ubuntu/squid@sha256:cebf4f2bd409780c430106cba8b87d5d4b2e652b290d440bf74a8cf027cd89c8

COPY squid.conf.template /etc/squid/squid.conf.template
COPY docker-entrypoint.sh /docker-entrypoint.sh

RUN sed -i 's/\r$//' /docker-entrypoint.sh && chmod +x /docker-entrypoint.sh

ENTRYPOINT ["/docker-entrypoint.sh"]
