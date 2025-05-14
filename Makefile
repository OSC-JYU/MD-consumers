IMAGES := $(shell docker images -f "dangling=true" -q)
CONTAINERS := $(shell docker ps -a -q -f status=exited)
VOLUME := md-consumer
VERSION := 25.04.29
REPOSITORY := osc.repo.kopla.jyu.fi
IMAGE := md-consumer


clean:
	docker rm -f $(CONTAINERS)
	docker rmi -f $(IMAGES)

build:
	docker build -t $(REPOSITORY)/messydesk/$(IMAGE):$(VERSION) .

start:
	docker run --rm -it --name $(IMAGE) --network=md-net\
		-e NOMAD_URL='http://host.containers.internal:4646/v1' \
		-e NATS_URL='http://nats-jetstreams:4222' \
		-e MD_URL='http://messydesk:8200' \
		$(REPOSITORY)/messydesk/$(IMAGE):$(VERSION) "node api-imaginary.mjs"

start_host:
	docker run --rm -it --name $(IMAGE) --network=host\
		$(REPOSITORY)/messydesk/$(IMAGE):$(VERSION) "node api-imaginary.mjs"


restart:
	docker stop $(IMAGE)
	docker rm $(IMAGE)
	$(MAKE) start

bash:
	docker exec -it $(IMAGE) bash
