# Signatures come in the image, so a cold start needs no network. Rebuilding the image is what updates them for good.
FROM clamav/clamav:1.5-debian@sha256:c21aa18cc0a358678255a3dfb343a4555b58f71b97d7b869df8fdf7ea0a5b4b1
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
COPY scan.conf /etc/clamav/scan.conf
COPY server.py /opt/server.py
RUN chown -R clamav:clamav /var/lib/clamav
USER clamav
ENV PYTHONUNBUFFERED=1
ENTRYPOINT ["python3", "/opt/server.py"]
EXPOSE 8080
