IMAGES := $(shell docker images -f "dangling=true" -q)
CONTAINERS := $(shell docker ps -a -q -f status=exited)
VOLUME := md-consumer-thumbnailer
VERSION := 25.05.28
REPOSITORY := localhost
IMAGE := md-consumer


clean:
	docker rm -f $(CONTAINERS)
	docker rmi -f $(IMAGES)

build:
	docker build -t $(REPOSITORY)/messydesk/$(IMAGE):$(VERSION) .

start_thumbnailer:
	docker run --rm -it --name $(IMAGE) \
		--net=host \
		-e TOPIC=md-thumbnailer \
		-e NOMAD=true \
		$(REPOSITORY)/messydesk/$(IMAGE):$(VERSION) "node src/index.mjs"

start_topic:
	docker run --rm -it --name $(IMAGE) \
		--net=host \
		-e TOPIC=$(TOPIC) \
		-e NOMAD=true \
		$(REPOSITORY)/messydesk/$(IMAGE):$(VERSION) "node src/index.mjs"




restart:
	docker stop $(IMAGE)
	docker rm $(IMAGE)
	$(MAKE) start

bash:
	docker exec -it $(IMAGE) bash
