# Signatures are built in, so the running Container needs no network (decision 83). Rebuilding the image is the only update, and
# a rebuild has to use no layer cache or it keeps the old signatures. The build fails if it can't get current ones.
FROM clamav/clamav:1.5-debian@sha256:c21aa18cc0a358678255a3dfb343a4555b58f71b97d7b869df8fdf7ea0a5b4b1
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*
COPY scan.conf /etc/clamav/scan.conf
COPY scanner /opt/podster/scanner
RUN chown -R clamav:clamav /var/lib/clamav

USER clamav
ENV TZ=UTC PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=/opt/podster
RUN freshclam --stdout --foreground --config-file=/etc/clamav/freshclam.conf
# Asks clamd itself, so what's checked here is what the server will read at start.
RUN python3 -m scanner.check_image

USER root
# Nothing in the running Container should even try to fetch anything.
RUN rm -f "$(command -v freshclam)" /etc/clamav/freshclam.conf
USER clamav
ENTRYPOINT ["python3", "-m", "scanner.server"]
EXPOSE 8080
