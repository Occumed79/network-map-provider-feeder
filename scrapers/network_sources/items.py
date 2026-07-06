import scrapy


class ClinicLocationItem(scrapy.Item):
    name = scrapy.Field()
    address = scrapy.Field()
    address1 = scrapy.Field()
    address2 = scrapy.Field()
    city = scrapy.Field()
    state = scrapy.Field()
    postalCode = scrapy.Field()
    phone = scrapy.Field()
    fax = scrapy.Field()
    website = scrapy.Field()
    hours = scrapy.Field()
    services = scrapy.Field()
    sourceTag = scrapy.Field()
    sourceUrl = scrapy.Field()
    evidenceNote = scrapy.Field()
    internalStatus = scrapy.Field()
    lat = scrapy.Field()
    lng = scrapy.Field()
