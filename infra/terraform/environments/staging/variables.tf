variable "region" {
  description = "Staging region."
  type        = string
  default     = "us-east-1"
}

variable "api_image" {
  description = "api-server image, pinned by digest."
  type        = string
}

variable "certificate_arn" {
  description = "ACM certificate for the staging API hostname."
  type        = string
}

variable "api_environment" {
  description = "Non-secret env vars for the api-server."
  type        = map(string)
  default     = {}
}
