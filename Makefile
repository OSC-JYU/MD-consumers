IMAGES := $(shell docker images -f "dangling=true" -q)
CONTAINERS := $(shell docker ps -a -q -f status=exited)
VOLUME := md-consumer-thumbnailer
VERSION := 0.3
REPOSITORY := messydesk
IMAGE := md-consumer


clean:
	docker rm -f $(CONTAINERS)
	docker rmi -f $(IMAGES)

build:
	docker build -t $(REPOSITORY)/$(IMAGE):$(VERSION) .


start_thumbnailer:
	docker run --rm -it --name $(IMAGE) \
		--net=host \
		-e TOPIC=md-thumbnailer \
		-e NOMAD_HCL_PATH=$(NOMAD_HCL_PATH) \
		$(REPOSITORY)/$(IMAGE):$(VERSION)

start_topic:
	docker run --rm -it --name $(IMAGE) \
		--net=host \
		-e TOPIC=$(TOPIC) \
		-e NOMAD_HCL_PATH=$(NOMAD_HCL_PATH) \
		$(REPOSITORY)/$(IMAGE):$(VERSION)

start_tesseract:
	docker run --rm -it --name $(IMAGE) \
		--net=host \
		-e TOPIC=md-tesseract \
		-e NOMAD_HCL_PATH=$(NOMAD_HCL_PATH) \
		$(REPOSITORY)/$(IMAGE):$(VERSION)




restart:
	docker stop $(IMAGE)
	docker rm $(IMAGE)
	$(MAKE) start

bash:
	docker exec -it $(IMAGE) bash
